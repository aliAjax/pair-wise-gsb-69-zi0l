// 核心规则 sanity 检查：容量门禁、会签重置、CAS 冲突
import '@angular/compiler';
import {
  checkCapacity,
  createDefaultLedger,
  buildReservation,
  evaluateWrite,
  migrateSnapshot,
} from './src/app/models/capacity.model.ts';
import { changeRequestReducer } from './src/app/store/change-request.reducer.ts';
import { ChangeRequestActions } from './src/app/store/change-request.actions.ts';

let failures = 0;
function assert(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name} ${extra}`);
  }
}

function makeChange(overrides = {}) {
  return {
    id: 'CHG-1',
    title: '测试变更',
    summary: '',
    owner: '张三',
    onCall: ['张三'],
    status: 'draft',
    risk: 'medium',
    resources: [{ id: 'r1', name: '资源', type: 'service', critical: false, dependencies: [] }],
    steps: [{ id: 's1', phase: 'execute', title: '步骤', owner: '张三', durationMinutes: 10, command: 'ls', completed: false }],
    window: { start: '2026-10-05T01:00', end: '2026-10-05T03:00', observationWindowMinutes: 30, blackoutProtected: false },
    approvals: [
      { stage: 'network', state: 'pending' },
      { stage: 'system', state: 'pending' },
      { stage: 'security', state: 'pending' },
      { stage: 'business', state: 'pending' },
    ],
    deviations: [],
    audit: [],
    capacity: { datacenterId: 'dc-east-1', rackUnits: 4, networkGbps: 10, serviceSlots: 1 },
    reservationIds: [],
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const ledger = createDefaultLedger();

// 1. 严重变更同时段上限 2
console.log('严重变更同机房同时段上限:');
const criticalWindow = { start: '2026-10-05T01:00', end: '2026-10-05T03:00' };
const existingCritical = [1, 2].map((n) =>
  makeChange({
    id: `CHG-C${n}`,
    status: 'submitted',
    risk: 'critical',
    window: criticalWindow,
  }),
);
const thirdCritical = makeChange({ id: 'CHG-C3', risk: 'critical', window: criticalWindow });
let rejections = checkCapacity(ledger, existingCritical, thirdCritical);
assert('第 3 项严重变更被拒绝', rejections.some((r) => r.code === 'CRITICAL_SLOT_FULL'));
const nonOverlapping = makeChange({
  id: 'CHG-C4',
  risk: 'critical',
  window: { start: '2026-10-06T01:00', end: '2026-10-06T03:00', observationWindowMinutes: 30, blackoutProtected: false },
});
rejections = checkCapacity(ledger, existingCritical, nonOverlapping);
assert('不同时段的严重变更放行', rejections.length === 0);
const mediumChange = makeChange({ id: 'CHG-M1', risk: 'medium', window: criticalWindow });
rejections = checkCapacity(ledger, existingCritical, mediumChange);
assert('非严重变更不受 2 项限制', !rejections.some((r) => r.code === 'CRITICAL_SLOT_FULL'));

// 2. 容量池校验
console.log('容量池校验:');
const hog = makeChange({ id: 'CHG-H1', capacity: { datacenterId: 'dc-east-1', rackUnits: 80, networkGbps: 10, serviceSlots: 1 } });
const hogLedger = { ...ledger, reservations: [buildReservation(hog)] };
const next = makeChange({ id: 'CHG-H2', capacity: { datacenterId: 'dc-east-1', rackUnits: 10, networkGbps: 5, serviceSlots: 1 } });
rejections = checkCapacity(hogLedger, [hog], next);
assert('机柜容量不足被拒绝', rejections.some((r) => r.code === 'CAPACITY_INSUFFICIENT' && r.message.includes('机柜')));
const fits = makeChange({ id: 'CHG-H3', capacity: { datacenterId: 'dc-east-1', rackUnits: 4, networkGbps: 5, serviceSlots: 1 } });
rejections = checkCapacity(hogLedger, [hog], fits);
assert('容量足够时放行', rejections.length === 0);
rejections = checkCapacity(ledger, [], makeChange({ id: 'CHG-N1', capacity: { datacenterId: '', rackUnits: 1, networkGbps: 1, serviceSlots: 1 } }));
assert('未选机房被拒绝', rejections.length > 0);

// 3. 提交即预留；容量不够拒绝并保留草稿
console.log('提交预留与拒绝:');
let state = changeRequestReducer(
  { ...undefined } === undefined ? undefined : undefined,
  { type: '@ngrx/store/init' },
);
state = changeRequestReducer(state, ChangeRequestActions.createChange({ change: makeChange({ id: 'CHG-S1' }) }));
state = changeRequestReducer(state, ChangeRequestActions.submitForReview({ id: 'CHG-S1' }));
let submitted = state.changes.find((c) => c.id === 'CHG-S1');
assert('提交后进入待会签', submitted.status === 'submitted');
assert('台账生成预留记录', state.ledger.reservations.some((r) => r.changeId === 'CHG-S1' && r.status === 'reserved'));
assert('变更关联预留号', submitted.reservationIds.length === 1);

// 塞满严重变更时段后提交第 3 项
state = changeRequestReducer(state, ChangeRequestActions.createChange({ change: makeChange({ id: 'CHG-K1', risk: 'critical' }) }));
state = changeRequestReducer(state, ChangeRequestActions.submitForReview({ id: 'CHG-K1' }));
state = changeRequestReducer(state, ChangeRequestActions.createChange({ change: makeChange({ id: 'CHG-K2', risk: 'critical' }) }));
state = changeRequestReducer(state, ChangeRequestActions.submitForReview({ id: 'CHG-K2' }));
state = changeRequestReducer(state, ChangeRequestActions.createChange({ change: makeChange({ id: 'CHG-K3', risk: 'critical' }) }));
const beforeReservations = state.ledger.reservations.length;
state = changeRequestReducer(state, ChangeRequestActions.submitForReview({ id: 'CHG-K3' }));
const rejectedChange = state.changes.find((c) => c.id === 'CHG-K3');
assert('第 3 项严重变更提交被拒', state.capacityError?.changeId === 'CHG-K3');
assert('被拒后仍是草稿', rejectedChange.status === 'draft');
assert('拒绝不产生新预留', state.ledger.reservations.length === beforeReservations);
assert('拒绝原因写入审计', rejectedChange.audit.some((a) => a.action === '容量校验失败'));

// 4. 审批中修改 → 会签重置 + 重新预留
console.log('审批中修改:');
const approved = state.changes.find((c) => c.id === 'CHG-K1');
state = changeRequestReducer(state, ChangeRequestActions.approveStage({ id: 'CHG-K1', stage: 'network', approver: '陆成', comment: '同意' }));
let mid = state.changes.find((c) => c.id === 'CHG-K1');
assert('网络负责人已签', mid.approvals[0].state === 'approved');
const oldReservation = mid.reservationIds[0];
state = changeRequestReducer(
  state,
  ChangeRequestActions.updateChange({ change: { ...mid, title: '修改后的方案' } }),
);
mid = state.changes.find((c) => c.id === 'CHG-K1');
assert('修改后仍在会签流程', mid.status === 'submitted');
assert('旧会签全部失效', mid.approvals.every((a) => a.state === 'pending'));
assert('会签自网络负责人重启', mid.approvals[0].stage === 'network' && mid.approvals[0].state === 'pending');
assert('旧预留已释放', state.ledger.reservations.find((r) => r.id === oldReservation)?.status === 'released');
assert('新预留已建立且关联', mid.reservationIds.length === 1 && mid.reservationIds[0] !== oldReservation);
assert('审计记录会签失效', mid.audit.some((a) => a.action === '审批中修改'));

// 5. 退回/完成释放容量
console.log('释放预留:');
state = changeRequestReducer(state, ChangeRequestActions.rejectStage({ id: 'CHG-K2', stage: 'network', approver: '陆成', comment: '窗口冲突' }));
const k2 = state.changes.find((c) => c.id === 'CHG-K2');
assert('退回后无有效预留', !state.ledger.reservations.some((r) => r.changeId === 'CHG-K2' && r.status === 'reserved'));
assert('退回状态正确', k2.status === 'rejected');

// 6. CAS 冲突：两个标签页基于同一版本写入
console.log('乐观锁:');
const snapshotV2 = { changes: [makeChange({ id: 'CHG-A' })], ledger, snapshotVersion: 2 };
const tabB = evaluateWrite(1, snapshotV2);
assert('标签页 B 基于旧版本写入被判冲突', tabB.allowed === false);
const tabA = evaluateWrite(2, snapshotV2);
assert('标签页 A 版本一致允许写入', tabA.allowed === true && tabA.nextVersion === 3);
const emptyStore = evaluateWrite(0, null);
assert('空存储首次写入允许', emptyStore.allowed === true && emptyStore.nextVersion === 1);

// 6b. 冲突时 reducer 加载先行方快照，本地修改不覆盖
const conflictState = changeRequestReducer(
  {
    changes: [makeChange({ id: 'CHG-B', version: 5 }), makeChange({ id: 'CHG-A', version: 1 })],
    ledger,
    snapshotVersion: 1,
    loading: false,
    error: null,
    persistenceError: null,
    capacityError: null,
    conflict: null,
  },
  ChangeRequestActions.persistConflict({
    stored: { changes: [makeChange({ id: 'CHG-A', version: 2 })], ledger, snapshotVersion: 2 },
    localChanges: [makeChange({ id: 'CHG-B', version: 5 }), makeChange({ id: 'CHG-A', version: 1 })],
  }),
);
assert('冲突后加载先行方台账', conflictState.snapshotVersion === 2 && conflictState.changes.length === 1);
assert('本地未写入修改保留在冲突记录', conflictState.conflict?.lostChanges.some((c) => c.id === 'CHG-B'));
assert('先行结果未被覆盖', conflictState.changes[0].id === 'CHG-A' && conflictState.changes[0].version === 2);

// 7. 迁移：旧数据补版本号与预留
console.log('迁移:');
const legacyChange = makeChange({ id: 'CHG-OLD', status: 'submitted' });
delete legacyChange.version;
delete legacyChange.reservationIds;
const migrated = migrateSnapshot({
  changes: [legacyChange],
  ledger: createDefaultLedger(),
  snapshotVersion: 0,
});
assert('补齐版本号', migrated.changes[0].version === 1);
assert('为持容量变更补建预留', migrated.ledger.reservations.some((r) => r.changeId === 'CHG-OLD' && r.status === 'reserved'));
assert('快照版本至少为 1', migrated.snapshotVersion >= 1);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
