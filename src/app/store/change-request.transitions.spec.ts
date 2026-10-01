import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POOLS,
  MAX_CRITICAL_PER_WINDOW,
  buildReservations,
  previewCapacity,
} from '../models/capacity.model';
import {
  ChangeRequest,
  ChangeStatus,
  RiskLevel,
  createEmptyApprovals,
} from '../models/change-request.model';
import { LedgerDocument, migrateDocument, seedDocument } from '../models/ledger.model';
import { commit } from './change-request.transitions';

const NOW = new Date('2026-10-01T00:00:00.000Z');

function makeChange(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'CHG-T1',
    title: '测试变更',
    summary: '',
    owner: '张三',
    onCall: ['张三'],
    status: 'draft',
    risk: 'high',
    resources: [
      { id: 'dc-east-1', name: '华东一区', type: 'datacenter', critical: true, dependencies: [] },
      { id: 'rack-a3', name: 'A3 机柜', type: 'rack', critical: false, dependencies: ['dc-east-1'] },
      { id: 'sw-core-a', name: '核心交换机', type: 'network', critical: true, dependencies: ['rack-a3'] },
      { id: 'svc-orders', name: '订单网关', type: 'service', critical: true, dependencies: ['sw-core-a'] },
    ],
    steps: [],
    window: { start: '2026-10-02T01:00', end: '2026-10-02T03:00', observationWindowMinutes: 30, blackoutProtected: false },
    approvals: createEmptyApprovals(),
    deviations: [],
    audit: [],
    version: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDocument(changes: ChangeRequest[]): LedgerDocument {
  return seedDocument(changes, DEFAULT_POOLS);
}

function criticalChange(id: string, status: ChangeStatus = 'submitted'): ChangeRequest {
  return makeChange({
    id,
    risk: 'critical',
    status,
    version: 1,
    window: { start: '2026-10-02T01:00', end: '2026-10-02T03:00', observationWindowMinutes: 30, blackoutProtected: false },
  });
}

describe('容量门禁与严重变更限制', () => {
  it('严重变更在同一机房同一时段最多占 2 项，第三项被拒绝', () => {
    const document = makeDocument([criticalChange('CHG-A'), criticalChange('CHG-B')]);
    const third = criticalChange('CHG-C');

    const result = commit(document, { type: 'save', change: third, submit: true }, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'capacity') {
      expect(result.issues.some((issue) => issue.code === 'CRITICAL_WINDOW_LIMIT')).toBe(true);
    } else {
      expect.unreachable('应返回容量门禁拒绝');
    }
    // 台账保持不变，先到两项的预留不受影响
    expect(document.reservations.filter((r) => r.status === 'active')).toHaveLength(6);
  });

  it(`同时段已有 ${MAX_CRITICAL_PER_WINDOW - 1} 项严重变更时仍可提交`, () => {
    const document = makeDocument([criticalChange('CHG-A')]);
    const second = criticalChange('CHG-B');

    const result = commit(document, { type: 'save', change: second, submit: true }, NOW);

    expect(result.ok).toBe(true);
  });

  it('窗口不重叠的严重变更不受限制', () => {
    const document = makeDocument([criticalChange('CHG-A'), criticalChange('CHG-B')]);
    const later = criticalChange('CHG-C');
    later.window = { ...later.window, start: '2026-10-03T01:00', end: '2026-10-03T03:00' };

    const result = commit(document, { type: 'save', change: later, submit: true }, NOW);

    expect(result.ok).toBe(true);
  });

  it('容量不足时拒绝提交且台账不变（草稿保留在页面侧）', () => {
    // 未分配机房机柜池总量 2，需求 3 必然不足
    const change = makeChange({
      id: 'CHG-BIG',
      resources: [
        { id: 'rack-x', name: 'X 机柜', type: 'rack', critical: false, dependencies: [], capacityDemand: 3 },
      ],
    });
    const document = makeDocument([]);

    const result = commit(document, { type: 'save', change, submit: true }, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'capacity') {
      expect(result.issues.some((issue) => issue.code === 'CAPACITY_SHORTAGE')).toBe(true);
    } else {
      expect.unreachable('应返回容量不足');
    }
    expect(document.changes).toHaveLength(0);
    expect(document.reservations).toHaveLength(0);
  });

  it('提交成功后按窗口生成机柜、网络、服务预留', () => {
    const document = makeDocument([]);
    const change = makeChange({ id: 'CHG-NEW' });

    const result = commit(document, { type: 'save', change, submit: true }, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const active = result.document.reservations.filter((r) => r.status === 'active');
      expect(active.map((r) => r.type).sort()).toEqual(['network', 'rack', 'service']);
      expect(active.every((r) => r.datacenterId === 'dc-east-1')).toBe(true);
      expect(active.every((r) => r.windowStart === '2026-10-02T01:00')).toBe(true);
      expect(result.document.changes[0].status).toBe('submitted');
    }
  });

  it('保存草稿不占用容量', () => {
    const document = makeDocument([]);
    const result = commit(document, { type: 'save', change: makeChange(), submit: false }, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.reservations.filter((r) => r.status === 'active')).toHaveLength(0);
    }
  });

  it('预检能提前看到容量缺口', () => {
    const document = makeDocument([]);
    const change = makeChange({
      resources: [
        { id: 'svc-a', name: '服务A', type: 'service', critical: true, dependencies: [], capacityDemand: 5 },
      ],
    });
    const preview = previewCapacity(change, document.pools, document.reservations, document.changes);
    expect(preview.issues.some((issue) => issue.code === 'CAPACITY_SHORTAGE')).toBe(true);
  });
});

describe('多标签页版本冲突', () => {
  it('后到保存基于旧版本时被拒绝，先行结果不被覆盖', () => {
    const document = makeDocument([makeChange({ id: 'CHG-X', version: 1, status: 'draft' })]);

    // 标签页 A 先保存：版本 1 → 2
    const tabA = commit(
      document,
      { type: 'save', change: { ...makeChange({ id: 'CHG-X', version: 1, title: 'A 的修改' }), status: 'draft' }, submit: false },
      NOW,
    );
    expect(tabA.ok).toBe(true);
    if (!tabA.ok) {
      return;
    }

    // 标签页 B 仍基于版本 1 保存 → 冲突
    const tabB = commit(
      tabA.document,
      { type: 'save', change: { ...makeChange({ id: 'CHG-X', version: 1, title: 'B 的修改' }), status: 'draft' }, submit: false },
      NOW,
    );

    expect(tabB.ok).toBe(false);
    if (!tabB.ok && tabB.reason === 'conflict') {
      expect(tabB.latest.version).toBe(2);
      expect(tabB.latest.title).toBe('A 的修改');
    } else {
      expect.unreachable('应返回版本冲突');
    }
    // 台账中仍是 A 的结果
    expect(tabA.document.changes.find((c) => c.id === 'CHG-X')?.title).toBe('A 的修改');
  });

  it('基于最新版本重新保存可以生效', () => {
    const document = makeDocument([makeChange({ id: 'CHG-X', version: 2, title: '最新', status: 'draft' })]);
    const rebased = makeChange({ id: 'CHG-X', version: 2, title: '基于最新再改', status: 'draft' });

    const result = commit(document, { type: 'save', change: rebased, submit: false }, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.changes[0].version).toBe(3);
      expect(result.document.changes[0].title).toBe('基于最新再改');
    }
  });
});

describe('审批中修改与会签重置', () => {
  it('审批中的方案被修改后旧会签失效，从网络负责人重新会签', () => {
    const submitted = makeChange({
      id: 'CHG-P',
      status: 'submitted',
      version: 3,
      approvals: [
        { stage: 'network', state: 'approved', approver: '陆成', comment: '同意', decidedAt: '2026-09-30T02:00:00.000Z' },
        { stage: 'system', state: 'pending' },
        { stage: 'security', state: 'pending' },
        { stage: 'business', state: 'pending' },
      ],
    });
    const document = makeDocument([submitted]);
    const edited = { ...submitted, title: '修改后的方案' };

    const result = commit(document, { type: 'save', change: edited, submit: false }, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const next = result.document.changes[0];
      expect(next.status).toBe('submitted');
      expect(next.approvals.every((approval) => approval.state === 'pending')).toBe(true);
      expect(next.approvals[0].stage).toBe('network');
      expect(next.audit.some((record) => record.action === '会签重置')).toBe(true);
      // 窗口未变时预留仍然有效
      expect(result.document.reservations.filter((r) => r.status === 'active').length).toBeGreaterThan(0);
    }
  });

  it('审批中修改窗口会按新窗口重新预留容量', () => {
    const submitted = makeChange({ id: 'CHG-P', status: 'submitted', version: 1 });
    const document = makeDocument([submitted]);
    const edited = {
      ...submitted,
      window: { ...submitted.window, start: '2026-10-05T01:00', end: '2026-10-05T03:00' },
    };

    const result = commit(document, { type: 'save', change: edited, submit: false }, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const active = result.document.reservations.filter((r) => r.status === 'active');
      expect(active.every((r) => r.windowStart === '2026-10-05T01:00')).toBe(true);
      expect(result.document.reservations.some((r) => r.status === 'released')).toBe(true);
    }
  });

  it('顺序会签：网络批准后才轮到系统，全部批准后状态为已批准', () => {
    const submitted = makeChange({ id: 'CHG-P', status: 'submitted', version: 1 });
    let document = makeDocument([submitted]);

    const outOfOrder = commit(
      document,
      { type: 'approve', id: 'CHG-P', stage: 'system', approver: '宋海', comment: '同意' },
      NOW,
    );
    expect(outOfOrder.ok).toBe(true);
    if (outOfOrder.ok) {
      expect(outOfOrder.changed).toBe(false);
    }

    for (const [stage, approver] of [
      ['network', '陆成'],
      ['system', '宋海'],
      ['security', '王珊'],
      ['business', '韩璐'],
    ] as const) {
      const result = commit(
        document,
        { type: 'approve', id: 'CHG-P', stage, approver, comment: '同意' },
        NOW,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        document = result.document;
      }
    }
    expect(document.changes[0].status).toBe('approved');
  });

  it('退回后释放容量预留', () => {
    const submitted = makeChange({ id: 'CHG-P', status: 'submitted', version: 1 });
    const document = makeDocument([submitted]);
    expect(document.reservations.filter((r) => r.status === 'active').length).toBeGreaterThan(0);

    const result = commit(
      document,
      { type: 'reject', id: 'CHG-P', stage: 'network', approver: '陆成', comment: '窗口不合适' },
      NOW,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.changes[0].status).toBe('rejected');
      expect(result.document.reservations.every((r) => r.status === 'released')).toBe(true);
    }
  });
});

describe('写入失败后的恢复一致性', () => {
  it('占用中的变更缺失预留时，重开浏览器加载会自愈补齐', () => {
    const submitted = makeChange({ id: 'CHG-P', status: 'submitted', version: 4 });
    const broken: LedgerDocument = {
      revision: 7,
      changes: [submitted],
      reservations: [], // 模拟写入中断留下的残缺台账
      pools: DEFAULT_POOLS,
    };

    const healed = migrateDocument(JSON.parse(JSON.stringify(broken)));

    const active = healed.reservations.filter((r) => r.changeId === 'CHG-P' && r.status === 'active');
    expect(active.map((r) => r.type).sort()).toEqual(['network', 'rack', 'service']);
    expect(healed.changes[0].approvals).toEqual(submitted.approvals);
    expect(healed.revision).toBe(7);
  });

  it('已结束变更的残留预留在加载时被释放', () => {
    const completed = makeChange({ id: 'CHG-D', status: 'completed', version: 2 });
    const stale = buildReservations(completed, DEFAULT_POOLS, '2026-09-30T00:00:00.000Z');
    const healed = migrateDocument({
      revision: 3,
      changes: [completed],
      reservations: stale,
      pools: DEFAULT_POOLS,
    });

    expect(healed.reservations.every((r) => r.status === 'released')).toBe(true);
  });

  it('旧版本数据缺少版本号与容量池时按默认值迁移', () => {
    const legacy = makeChange({ id: 'CHG-L', status: 'submitted' }) as Partial<ChangeRequest>;
    delete legacy.version;

    const healed = migrateDocument({ changes: [legacy], reservations: [] });

    expect(healed.changes[0].version).toBe(1);
    expect(healed.pools.length).toBeGreaterThan(0);
    expect(healed.reservations.filter((r) => r.status === 'active').length).toBeGreaterThan(0);
  });
});
