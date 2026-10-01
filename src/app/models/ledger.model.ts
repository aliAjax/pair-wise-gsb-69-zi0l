import {
  CapacityPool,
  CapacityReservation,
  DEFAULT_POOLS,
  OCCUPYING_STATUSES,
  buildReservations,
} from './capacity.model';
import { ChangeRequest } from './change-request.model';

/**
 * 容量台账文档：变更计划、容量预留、容量池写在同一份文档里，
 * 单次原子写入，保证写入失败恢复后计划、容量、审批状态一致。
 */
export interface LedgerDocument {
  revision: number;
  changes: ChangeRequest[];
  reservations: CapacityReservation[];
  pools: CapacityPool[];
}

export const EMPTY_DOCUMENT: LedgerDocument = {
  revision: 0,
  changes: [],
  reservations: [],
  pools: [],
};

/** 首次播种：为占用中的变更补齐预留记录。 */
export function seedDocument(changes: ChangeRequest[], pools: CapacityPool[]): LedgerDocument {
  const versioned = changes.map((change) => ({
    ...change,
    version: typeof change.version === 'number' ? change.version : 1,
  }));
  const reservations = versioned
    .filter((change) => OCCUPYING_STATUSES.includes(change.status))
    .flatMap((change) => buildReservations(change, pools, change.updatedAt));
  return { revision: 1, changes: versioned, reservations, pools };
}

/**
 * 读取时自愈：补齐缺失的版本号与容量池、清理孤儿预留、
 * 为占用中的变更重建预留、释放已结束变更的预留。
 * 写入中断或旧版本数据在重开浏览器后仍能恢复出一致的容量与审批状态。
 */
export function migrateDocument(raw: unknown): LedgerDocument {
  const source = (raw ?? {}) as Partial<LedgerDocument>;
  const pools: CapacityPool[] =
    Array.isArray(source.pools) && source.pools.length > 0 ? source.pools : DEFAULT_POOLS;
  const changes = (Array.isArray(source.changes) ? source.changes : []).map((change) => ({
    ...change,
    version: typeof change.version === 'number' ? change.version : 1,
  }));
  const byId = new Map(changes.map((change) => [change.id, change]));

  let reservations = (Array.isArray(source.reservations) ? source.reservations : []).filter(
    (reservation) => byId.has(reservation.changeId),
  );
  const now = new Date().toISOString();
  reservations = reservations.map((reservation) => {
    const change = byId.get(reservation.changeId);
    if (
      reservation.status === 'active' &&
      change &&
      !OCCUPYING_STATUSES.includes(change.status)
    ) {
      return { ...reservation, status: 'released' as const, releasedAt: reservation.releasedAt ?? now };
    }
    return reservation;
  });
  changes
    .filter((change) => OCCUPYING_STATUSES.includes(change.status))
    .forEach((change) => {
      const hasActive = reservations.some(
        (reservation) => reservation.changeId === change.id && reservation.status === 'active',
      );
      if (!hasActive) {
        reservations = [
          ...reservations,
          ...buildReservations(change, pools, change.updatedAt || now),
        ];
      }
    });

  return {
    revision: typeof source.revision === 'number' ? source.revision : 1,
    changes,
    reservations,
    pools,
  };
}
