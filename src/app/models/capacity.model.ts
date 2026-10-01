import {
  CapacityDemand,
  ChangeRequest,
  ChangeWindow,
  ValidationIssue,
  createEmptyChange,
  isWindowOverlapping,
} from './change-request.model';

/** 严重变更在同一机房同一时段的最大并发数 */
export const CRITICAL_SLOT_LIMIT = 2;

export type ReservationStatus = 'reserved' | 'released';

export interface CapacityPool {
  datacenterId: string;
  datacenterName: string;
  rackUnits: number;
  networkGbps: number;
  serviceSlots: number;
  maxCriticalChanges: number;
}

export interface CapacityReservation {
  id: string;
  changeId: string;
  datacenterId: string;
  window: Pick<ChangeWindow, 'start' | 'end'>;
  demand: Omit<CapacityDemand, 'datacenterId'>;
  status: ReservationStatus;
  createdAt: string;
  releasedAt?: string;
}

export interface CapacityLedger {
  pools: CapacityPool[];
  reservations: CapacityReservation[];
}

/** 工作区快照：变更、台账与版本号一起原子写入，作为跨标签页乐观锁依据 */
export interface WorkspaceSnapshot {
  changes: ChangeRequest[];
  ledger: CapacityLedger;
  snapshotVersion: number;
}

export interface CapacityRejection {
  code: 'CAPACITY_INSUFFICIENT' | 'CRITICAL_SLOT_FULL';
  message: string;
}

export interface PoolUsage {
  rackUnits: number;
  networkGbps: number;
  serviceSlots: number;
  criticalCount: number;
  reservations: CapacityReservation[];
}

/** 持有容量、参与时段占用的变更状态 */
export const CAPACITY_HOLDING_STATUSES = ['submitted', 'approved', 'executing'];

export function createDefaultLedger(): CapacityLedger {
  return {
    pools: [
      {
        datacenterId: 'dc-east-1',
        datacenterName: '华东一区',
        rackUnits: 84,
        networkGbps: 400,
        serviceSlots: 24,
        maxCriticalChanges: CRITICAL_SLOT_LIMIT,
      },
      {
        datacenterId: 'dc-north-2',
        datacenterName: '华北二区',
        rackUnits: 60,
        networkGbps: 240,
        serviceSlots: 16,
        maxCriticalChanges: CRITICAL_SLOT_LIMIT,
      },
    ],
    reservations: [],
  };
}

export function findPool(ledger: CapacityLedger, datacenterId: string): CapacityPool | undefined {
  return ledger.pools.find((pool) => pool.datacenterId === datacenterId);
}

/** 指定机房、指定窗口内的有效预留（可排除某个变更自身） */
export function overlappingReservations(
  ledger: CapacityLedger,
  datacenterId: string,
  window: Pick<ChangeWindow, 'start' | 'end'>,
  excludeChangeId?: string,
): CapacityReservation[] {
  return ledger.reservations.filter(
    (reservation) =>
      reservation.status === 'reserved' &&
      reservation.datacenterId === datacenterId &&
      reservation.changeId !== excludeChangeId &&
      isWindowOverlapping(reservation.window, window),
  );
}

/** 计算机房在指定窗口内的容量占用与严重变更计数 */
export function poolUsage(
  ledger: CapacityLedger,
  changes: ChangeRequest[],
  datacenterId: string,
  window: Pick<ChangeWindow, 'start' | 'end'>,
  excludeChangeId?: string,
): PoolUsage {
  const reservations = overlappingReservations(ledger, datacenterId, window, excludeChangeId);
  const criticalCount = changes.filter(
    (change) =>
      change.id !== excludeChangeId &&
      change.risk === 'critical' &&
      CAPACITY_HOLDING_STATUSES.includes(change.status) &&
      change.capacity.datacenterId === datacenterId &&
      isWindowOverlapping(change.window, window),
  ).length;

  return {
    rackUnits: reservations.reduce((sum, item) => sum + item.demand.rackUnits, 0),
    networkGbps: reservations.reduce((sum, item) => sum + item.demand.networkGbps, 0),
    serviceSlots: reservations.reduce((sum, item) => sum + item.demand.serviceSlots, 0),
    criticalCount,
    reservations,
  };
}

/**
 * 提交/修改前的容量门禁：
 * 1. 严重变更在同一机房同一时段最多占 maxCriticalChanges 项；
 * 2. 机柜、网络、服务容量与同窗口有效预留累加后不得超池。
 */
export function checkCapacity(
  ledger: CapacityLedger,
  changes: ChangeRequest[],
  change: ChangeRequest,
): CapacityRejection[] {
  const demand = change.capacity;
  if (!demand.datacenterId) {
    return [
      {
        code: 'CAPACITY_INSUFFICIENT',
        message: '未选择机房，无法预留机柜、网络和服务容量。',
      },
    ];
  }
  const pool = findPool(ledger, demand.datacenterId);
  if (!pool) {
    return [
      {
        code: 'CAPACITY_INSUFFICIENT',
        message: `机房 ${demand.datacenterId} 不在容量台账中，无法预留。`,
      },
    ];
  }

  const usage = poolUsage(ledger, changes, demand.datacenterId, change.window, change.id);
  const rejections: CapacityRejection[] = [];

  if (change.risk === 'critical' && usage.criticalCount >= pool.maxCriticalChanges) {
    rejections.push({
      code: 'CRITICAL_SLOT_FULL',
      message: `严重变更在${pool.datacenterName}同一时段最多 ${pool.maxCriticalChanges} 项，当前窗口已占用 ${usage.criticalCount} 项。`,
    });
  }

  const dimensions: Array<{
    label: string;
    requested: number;
    used: number;
    total: number;
    unit: string;
  }> = [
    {
      label: '机柜',
      requested: demand.rackUnits,
      used: usage.rackUnits,
      total: pool.rackUnits,
      unit: 'U',
    },
    {
      label: '网络',
      requested: demand.networkGbps,
      used: usage.networkGbps,
      total: pool.networkGbps,
      unit: 'Gbps',
    },
    {
      label: '服务',
      requested: demand.serviceSlots,
      used: usage.serviceSlots,
      total: pool.serviceSlots,
      unit: ' 实例',
    },
  ];

  dimensions
    .filter((item) => item.requested > 0 && item.used + item.requested > item.total)
    .forEach((item) => {
      rejections.push({
        code: 'CAPACITY_INSUFFICIENT',
        message: `${pool.datacenterName}${item.label}容量不足：本窗口已预留 ${item.used}${item.unit}，本次需求 ${item.requested}${item.unit}，池上限 ${item.total}${item.unit}。`,
      });
    });

  return rejections;
}

export function buildReservation(change: ChangeRequest): CapacityReservation {
  return {
    id: `RSV-${change.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    changeId: change.id,
    datacenterId: change.capacity.datacenterId,
    window: { start: change.window.start, end: change.window.end },
    demand: {
      rackUnits: change.capacity.rackUnits,
      networkGbps: change.capacity.networkGbps,
      serviceSlots: change.capacity.serviceSlots,
    },
    status: 'reserved',
    createdAt: new Date().toISOString(),
  };
}

/** 释放某变更持有的全部有效预留，返回新数组（不修改入参） */
export function releaseForChange(
  reservations: CapacityReservation[],
  changeId: string,
): CapacityReservation[] {
  const releasedAt = new Date().toISOString();
  return reservations.map((reservation) =>
    reservation.changeId === changeId && reservation.status === 'reserved'
      ? { ...reservation, status: 'released', releasedAt }
      : reservation,
  );
}

export function reservationsForChange(
  ledger: CapacityLedger,
  changeId: string,
): CapacityReservation[] {
  return ledger.reservations.filter((reservation) => reservation.changeId === changeId);
}

/** 容量维度的校验问题，与 validateChange 结果合并后统一展示 */
export function validateCapacity(
  change: ChangeRequest,
  allChanges: ChangeRequest[],
  ledger: CapacityLedger,
): ValidationIssue[] {
  return checkCapacity(ledger, allChanges, change).map((rejection) => ({
    id: `${change.id}-capacity-${rejection.code}`,
    changeId: change.id,
    severity: 'blocker' as const,
    code: rejection.code,
    title: rejection.code === 'CRITICAL_SLOT_FULL' ? '严重变更时段已满' : '容量不足，无法预留',
    detail: rejection.message,
    suggestedAction: '调整执行窗口、缩减容量需求，或等待同时段变更释放容量后再提交。',
  }));
}

export function demandLabel(demand: CapacityDemand): string {
  return `机柜 ${demand.rackUnits}U · 网络 ${demand.networkGbps}Gbps · 服务 ${demand.serviceSlots} 实例`;
}

/**
 * 比较并交换判定：存储中的快照版本与写入方基线一致才允许写入，
 * 否则判定冲突，由调用方加载对方快照，绝不覆盖先行结果。
 */
export function evaluateWrite(
  expectedVersion: number,
  stored: WorkspaceSnapshot | null,
): { allowed: boolean; nextVersion: number } {
  const storedVersion = stored?.snapshotVersion ?? 0;
  return {
    allowed: !stored || storedVersion === expectedVersion,
    nextVersion: storedVersion + 1,
  };
}

/**
 * 快照迁移：补齐旧数据缺失的版本号、容量需求和预留关联；
 * 对处于持容量状态但没有预留记录的变更补建预留，保证台账一致。
 */
export function migrateSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const template = createEmptyChange();
  const changes = (snapshot.changes ?? []).map((change) => ({
    ...change,
    version: change.version ?? 1,
    capacity: change.capacity ?? { ...template.capacity },
    reservationIds: change.reservationIds ?? [],
  }));

  const ledger: CapacityLedger = {
    pools: snapshot.ledger?.pools?.length ? snapshot.ledger.pools : createDefaultLedger().pools,
    reservations: snapshot.ledger?.reservations ?? [],
  };

  const reservedChangeIds = new Set(
    ledger.reservations
      .filter((reservation) => reservation.status === 'reserved')
      .map((reservation) => reservation.changeId),
  );
  const missing: CapacityReservation[] = changes
    .filter(
      (change) =>
        CAPACITY_HOLDING_STATUSES.includes(change.status) &&
        change.capacity.datacenterId &&
        !reservedChangeIds.has(change.id),
    )
    .map((change) => buildReservation(change));

  return {
    changes,
    ledger:
      missing.length > 0
        ? { ...ledger, reservations: [...missing, ...ledger.reservations] }
        : ledger,
    snapshotVersion: Math.max(1, snapshot.snapshotVersion ?? 0),
  };
}
