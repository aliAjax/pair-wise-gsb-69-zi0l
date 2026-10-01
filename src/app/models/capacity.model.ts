import { ChangeRequest, ChangeStatus, ChangeWindow } from './change-request.model';

export type CapacityPoolType = 'rack' | 'network' | 'service';

export interface CapacityPool {
  datacenterId: string;
  datacenterName: string;
  type: CapacityPoolType;
  total: number;
  unit: string;
}

export interface CapacityReservation {
  id: string;
  changeId: string;
  datacenterId: string;
  type: CapacityPoolType;
  amount: number;
  windowStart: string;
  windowEnd: string;
  status: 'active' | 'released';
  createdAt: string;
  releasedAt?: string;
}

export interface CapacityDemand {
  datacenterId: string;
  type: CapacityPoolType;
  amount: number;
}

export interface CapacityIssue {
  code: 'CAPACITY_SHORTAGE' | 'CRITICAL_WINDOW_LIMIT' | 'POOL_MISSING';
  datacenterId: string;
  type?: CapacityPoolType;
  title: string;
  detail: string;
}

export interface CapacityPreviewLine extends CapacityDemand {
  datacenterName: string;
  total: number;
  reserved: number;
  available: number;
  unit: string;
}

export interface CapacityPreview {
  datacenters: string[];
  lines: CapacityPreviewLine[];
  issues: CapacityIssue[];
}

/** 严重变更在同一机房同一时段最多允许并发的数量。 */
export const MAX_CRITICAL_PER_WINDOW = 2;

export const UNASSIGNED_DATACENTER = 'dc-unassigned';

/** 占用容量台账的变更状态：草稿、退回、已结束的不占容量。 */
export const OCCUPYING_STATUSES: ChangeStatus[] = ['submitted', 'approved', 'executing'];

export const CAPACITY_TYPE_LABELS: Record<CapacityPoolType, string> = {
  rack: '机柜',
  network: '网络',
  service: '服务',
};

export const DEFAULT_POOLS: CapacityPool[] = [
  { datacenterId: 'dc-east-1', datacenterName: '华东一区', type: 'rack', total: 4, unit: '个机柜位' },
  { datacenterId: 'dc-east-1', datacenterName: '华东一区', type: 'network', total: 3, unit: '条上联通道' },
  { datacenterId: 'dc-east-1', datacenterName: '华东一区', type: 'service', total: 4, unit: '个服务实例' },
  { datacenterId: 'dc-east-2', datacenterName: '华东二区', type: 'rack', total: 3, unit: '个机柜位' },
  { datacenterId: 'dc-east-2', datacenterName: '华东二区', type: 'network', total: 2, unit: '条上联通道' },
  { datacenterId: 'dc-east-2', datacenterName: '华东二区', type: 'service', total: 3, unit: '个服务实例' },
  { datacenterId: UNASSIGNED_DATACENTER, datacenterName: '未分配机房', type: 'rack', total: 2, unit: '个机柜位' },
  { datacenterId: UNASSIGNED_DATACENTER, datacenterName: '未分配机房', type: 'network', total: 2, unit: '条上联通道' },
  { datacenterId: UNASSIGNED_DATACENTER, datacenterName: '未分配机房', type: 'service', total: 2, unit: '个服务实例' },
];

export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aS = new Date(aStart).getTime();
  const aE = new Date(aEnd).getTime();
  const bS = new Date(bStart).getTime();
  const bE = new Date(bEnd).getTime();
  return aS < bE && bS < aE;
}

function windowOverlaps(aStart: string, aEnd: string, window: ChangeWindow): boolean {
  return rangesOverlap(aStart, aEnd, window.start, window.end);
}

/**
 * 解析资源所属机房：沿依赖链找机房类资源或台账中已知的机房 ID，
 * 找不到时回退到变更内第一个机房资源，最后落入“未分配机房”。
 */
export function resolveResourceDatacenter(
  change: ChangeRequest,
  resource: ChangeRequest['resources'][number],
  pools: CapacityPool[],
): string {
  if (resource.type === 'datacenter') {
    return resource.id;
  }
  const knownDatacenters = new Set(pools.map((pool) => pool.datacenterId));
  const byId = new Map(change.resources.map((item) => [item.id, item]));
  const datacentersInChange = new Set(
    change.resources.filter((item) => item.type === 'datacenter').map((item) => item.id),
  );
  const visited = new Set<string>();
  const queue = [...resource.dependencies];
  while (queue.length > 0) {
    const dependencyId = queue.shift() as string;
    if (visited.has(dependencyId)) {
      continue;
    }
    visited.add(dependencyId);
    if (datacentersInChange.has(dependencyId) || knownDatacenters.has(dependencyId)) {
      return dependencyId;
    }
    const dependency = byId.get(dependencyId);
    if (dependency) {
      queue.push(...dependency.dependencies);
    }
  }
  return change.resources.find((item) => item.type === 'datacenter')?.id ?? UNASSIGNED_DATACENTER;
}

/** 变更占用的机房集合（用于严重变更并发限制）。 */
export function occupiedDatacenters(change: ChangeRequest, pools: CapacityPool[]): string[] {
  const datacenters = new Set(
    change.resources.map((resource) => resolveResourceDatacenter(change, resource, pools)),
  );
  if (datacenters.size === 0) {
    datacenters.add(UNASSIGNED_DATACENTER);
  }
  return [...datacenters];
}

/** 计算机柜、网络、服务三类容量需求，按机房聚合。 */
export function computeDemand(change: ChangeRequest, pools: CapacityPool[]): CapacityDemand[] {
  const demand = new Map<string, CapacityDemand>();
  change.resources
    .filter(
      (resource): resource is ChangeRequest['resources'][number] & { type: CapacityPoolType } =>
        resource.type === 'rack' || resource.type === 'network' || resource.type === 'service',
    )
    .forEach((resource) => {
      const datacenterId = resolveResourceDatacenter(change, resource, pools);
      const key = `${datacenterId}|${resource.type}`;
      const existing = demand.get(key);
      const amount = resource.capacityDemand && resource.capacityDemand > 0 ? resource.capacityDemand : 1;
      if (existing) {
        existing.amount += amount;
      } else {
        demand.set(key, { datacenterId, type: resource.type, amount });
      }
    });
  return [...demand.values()];
}

/** 严重变更同一机房同一时段最多 2 项。 */
export function checkCriticalLimit(
  change: ChangeRequest,
  allChanges: ChangeRequest[],
  datacenters: string[],
  pools: CapacityPool[],
): CapacityIssue[] {
  if (change.risk !== 'critical') {
    return [];
  }
  return datacenters.flatMap((datacenterId) => {
    const concurrent = allChanges.filter(
      (candidate) =>
        candidate.id !== change.id &&
        candidate.risk === 'critical' &&
        OCCUPYING_STATUSES.includes(candidate.status) &&
        rangesOverlap(candidate.window.start, candidate.window.end, change.window.start, change.window.end) &&
        occupiedDatacenters(candidate, pools).includes(datacenterId),
    );
    if (concurrent.length + 1 <= MAX_CRITICAL_PER_WINDOW) {
      return [];
    }
    const pool = pools.find((item) => item.datacenterId === datacenterId);
    const name = pool?.datacenterName ?? datacenterId;
    return [
      {
        code: 'CRITICAL_WINDOW_LIMIT' as const,
        datacenterId,
        title: `${name}同时段严重变更超过 ${MAX_CRITICAL_PER_WINDOW} 项`,
        detail: `该时段已有 ${concurrent.map((item) => item.id).join('、')} 等 ${concurrent.length} 项严重变更占用，严重变更在同一机房同一时段最多 ${MAX_CRITICAL_PER_WINDOW} 项。`,
      },
    ];
  });
}

/** 容量台账校验：需求不能超过池总量减去同时段已预留。 */
export function checkCapacity(
  demand: CapacityDemand[],
  window: ChangeWindow,
  pools: CapacityPool[],
  reservations: CapacityReservation[],
  excludeChangeId?: string,
): CapacityIssue[] {
  return demand.flatMap((item): CapacityIssue[] => {
    const pool = pools.find(
      (candidate) => candidate.datacenterId === item.datacenterId && candidate.type === item.type,
    );
    const label = CAPACITY_TYPE_LABELS[item.type];
    if (!pool) {
      return [
        {
          code: 'POOL_MISSING' as const,
          datacenterId: item.datacenterId,
          type: item.type,
          title: `${item.datacenterId} 未配置${label}容量池`,
          detail: '容量台账中没有该机房的对应容量池，无法预留，请先维护台账。',
        },
      ];
    }
    const reserved = reservations
      .filter(
        (reservation) =>
          reservation.status === 'active' &&
          reservation.changeId !== excludeChangeId &&
          reservation.datacenterId === item.datacenterId &&
          reservation.type === item.type &&
          windowOverlaps(reservation.windowStart, reservation.windowEnd, window),
      )
      .reduce((total, reservation) => total + reservation.amount, 0);
    const available = pool.total - reserved;
    if (item.amount <= available) {
      return [];
    }
    return [
      {
        code: 'CAPACITY_SHORTAGE' as const,
        datacenterId: item.datacenterId,
        type: item.type,
        title: `${pool.datacenterName}${label}容量不足`,
        detail: `本次需要 ${item.amount} ${pool.unit}，同时段已预留 ${reserved} / 总量 ${pool.total}，仅剩 ${available}，无法完成预留。`,
      },
    ];
  });
}

/** 提交前预检：返回容量占用明细与全部容量类问题，供页面实时展示。 */
export function previewCapacity(
  change: ChangeRequest,
  pools: CapacityPool[],
  reservations: CapacityReservation[],
  allChanges: ChangeRequest[],
): CapacityPreview {
  const datacenters = occupiedDatacenters(change, pools);
  const demand = computeDemand(change, pools);
  const lines = demand.map((item) => {
    const pool = pools.find(
      (candidate) => candidate.datacenterId === item.datacenterId && candidate.type === item.type,
    );
    const reserved = reservations
      .filter(
        (reservation) =>
          reservation.status === 'active' &&
          reservation.changeId !== change.id &&
          reservation.datacenterId === item.datacenterId &&
          reservation.type === item.type &&
          windowOverlaps(reservation.windowStart, reservation.windowEnd, change.window),
      )
      .reduce((total, reservation) => total + reservation.amount, 0);
    const total = pool?.total ?? 0;
    return {
      ...item,
      datacenterName: pool?.datacenterName ?? item.datacenterId,
      total,
      reserved,
      available: total - reserved,
      unit: pool?.unit ?? '',
    };
  });
  const issues = [
    ...checkCriticalLimit(change, allChanges, datacenters, pools),
    ...checkCapacity(demand, change.window, pools, reservations, change.id),
  ];
  return { datacenters, lines, issues };
}

/** 按需求生成容量预留记录。 */
export function buildReservations(
  change: ChangeRequest,
  pools: CapacityPool[],
  createdAt: string,
): CapacityReservation[] {
  return computeDemand(change, pools).map((demand) => ({
    id: `rsv-${change.id}-${demand.datacenterId}-${demand.type}`,
    changeId: change.id,
    datacenterId: demand.datacenterId,
    type: demand.type,
    amount: demand.amount,
    windowStart: change.window.start,
    windowEnd: change.window.end,
    status: 'active',
    createdAt,
  }));
}

/** 释放某个变更的全部有效预留。 */
export function releaseReservations(
  reservations: CapacityReservation[],
  changeId: string,
  releasedAt: string,
): CapacityReservation[] {
  return reservations.map((reservation) =>
    reservation.changeId === changeId && reservation.status === 'active'
      ? { ...reservation, status: 'released' as const, releasedAt }
      : reservation,
  );
}
