import { createReducer, on } from '@ngrx/store';
import {
  CapacityLedger,
  buildReservation,
  checkCapacity,
  createDefaultLedger,
  findPool,
  releaseForChange,
} from '../models/capacity.model';
import {
  ApprovalStage,
  ChangeRequest,
  APPROVAL_ORDER,
  createAudit,
  createEmptyApprovals,
} from '../models/change-request.model';
import { ChangeRequestActions } from './change-request.actions';

export interface CapacityError {
  changeId: string;
  reasons: string[];
  at: string;
}

export interface PersistConflict {
  at: string;
  snapshotVersion: number;
  lostChanges: ChangeRequest[];
}

export interface ChangeRequestState {
  changes: ChangeRequest[];
  ledger: CapacityLedger;
  snapshotVersion: number;
  loading: boolean;
  error: string | null;
  persistenceError: string | null;
  capacityError: CapacityError | null;
  conflict: PersistConflict | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  changes: [],
  ledger: createDefaultLedger(),
  snapshotVersion: 0,
  loading: false,
  error: null,
  persistenceError: null,
  capacityError: null,
  conflict: null,
};

/** 每次本地变更都推进版本号，作为跨标签页冲突比对依据 */
function touch(change: ChangeRequest): ChangeRequest {
  return { ...change, version: (change.version ?? 0) + 1, updatedAt: new Date().toISOString() };
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return APPROVAL_ORDER.find((stage) =>
    change.approvals.some((approval) => approval.stage === stage && approval.state === 'pending'),
  ) ?? null;
}

function capacityFailure(state: ChangeRequestState, changeId: string, reasons: string[]): ChangeRequestState {
  return {
    ...state,
    capacityError: { changeId, reasons, at: new Date().toISOString() },
    changes: state.changes.map((change) =>
      change.id === changeId
        ? touch({
            ...change,
            audit: [
              createAudit('容量校验失败', `容量不足，变更未提交：${reasons.join('；')}`),
              ...change.audit,
            ],
          })
        : change,
    ),
  };
}

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { snapshot }) => ({
    ...state,
    changes: snapshot.changes,
    ledger: snapshot.ledger,
    snapshotVersion: snapshot.snapshotVersion,
    loading: false,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.createChange, (state, { change }) => ({
    ...state,
    capacityError: null,
    changes: [
      {
        ...change,
        version: 1,
        audit: [createAudit('创建草稿', `创建变更 ${change.id}`), ...change.audit],
      },
      ...state.changes,
    ],
  })),
  on(ChangeRequestActions.updateChange, (state, { change }) => {
    const existing = state.changes.find((item) => item.id === change.id);
    if (!existing) {
      return state;
    }

    // 审批中的方案被修改：先重新校验容量，通过则旧会签失效、重新预留并自网络负责人重签
    if (existing.status === 'submitted') {
      const rejections = checkCapacity(state.ledger, state.changes, change);
      if (rejections.length > 0) {
        return capacityFailure(
          state,
          change.id,
          rejections.map((item) => item.message),
        );
      }

      const reservation = buildReservation(change);
      const pool = findPool(state.ledger, change.capacity.datacenterId);
      return {
        ...state,
        capacityError: null,
        ledger: {
          ...state.ledger,
          reservations: [
            reservation,
            ...releaseForChange(state.ledger.reservations, change.id),
          ],
        },
        changes: state.changes.map((item) =>
          item.id === change.id
            ? touch({
                ...change,
                approvals: createEmptyApprovals(),
                reservationIds: [reservation.id],
                audit: [
                  createAudit(
                    '审批中修改',
                    `方案在会签期间被修改，已有会签失效，自网络负责人重新会签；已重新预留${pool?.datacenterName ?? ''}容量`,
                  ),
                  ...item.audit,
                ],
              })
            : item,
        ),
      };
    }

    return {
      ...state,
      capacityError: null,
      changes: state.changes.map((item) =>
        item.id === change.id
          ? touch({
              ...change,
              audit: [createAudit('保存变更方案', '更新资源、步骤或窗口信息'), ...item.audit],
            })
          : item,
      ),
    };
  }),
  on(ChangeRequestActions.deleteDraft, (state, { id }) => ({
    ...state,
    ledger: { ...state.ledger, reservations: releaseForChange(state.ledger.reservations, id) },
    changes: state.changes.filter((change) => change.id !== id || change.status !== 'draft'),
  })),
  on(ChangeRequestActions.submitForReview, (state, { id }) => {
    const change = state.changes.find((item) => item.id === id);
    if (!change || !['draft', 'rejected'].includes(change.status)) {
      return state;
    }

    // 提交前先预留机柜、网络和服务容量；容量不够则拒绝提交并保留草稿
    const rejections = checkCapacity(state.ledger, state.changes, change);
    if (rejections.length > 0) {
      return capacityFailure(
        state,
        id,
        rejections.map((item) => item.message),
      );
    }

    const reservation = buildReservation(change);
    const pool = findPool(state.ledger, change.capacity.datacenterId);
    return {
      ...state,
      capacityError: null,
      ledger: { ...state.ledger, reservations: [reservation, ...state.ledger.reservations] },
      changes: state.changes.map((item) =>
        item.id === id
          ? touch({
              ...item,
              status: 'submitted',
              approvals: createEmptyApprovals(),
              reservationIds: [reservation.id],
              audit: [
                createAudit(
                  '提交审批',
                  `已预留${pool?.datacenterName ?? change.capacity.datacenterId}容量（机柜 ${change.capacity.rackUnits}U、网络 ${change.capacity.networkGbps}Gbps、服务 ${change.capacity.serviceSlots} 实例），进入网络、系统、安全、业务顺序会签`,
                ),
                ...item.audit,
              ],
            })
          : item,
      ),
    };
  }),
  on(ChangeRequestActions.approveStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    changes: state.changes.map((change) => {
      if (change.id !== id || nextPendingStage(change) !== stage) {
        return change;
      }

      const approvals = change.approvals.map((approval) =>
        approval.stage === stage
          ? {
              ...approval,
              state: 'approved' as const,
              approver,
              comment,
              decidedAt: new Date().toISOString(),
            }
          : approval,
      );
      const allApproved = approvals.every((approval) =>
        approval.stage === stage ? true : approval.state === 'approved',
      );

      return touch({
        ...change,
        status: allApproved ? 'approved' : 'submitted',
        approvals,
        audit: [createAudit('阶段会签', `${stage} 已由 ${approver} 批准：${comment}`), ...change.audit],
      });
    }),
  })),
  on(ChangeRequestActions.rejectStage, (state, { id, stage, approver, comment }) => ({
    ...state,
    // 会签退回即释放容量预留
    ledger: { ...state.ledger, reservations: releaseForChange(state.ledger.reservations, id) },
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            status: 'rejected',
            reservationIds: [],
            approvals: change.approvals.map((approval) =>
              approval.stage === stage
                ? {
                    ...approval,
                    state: 'rejected',
                    approver,
                    comment,
                    decidedAt: new Date().toISOString(),
                  }
                : approval,
            ),
            audit: [
              createAudit('审批退回', `${stage} 由 ${approver} 退回：${comment}；容量预留已释放`),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.startExecution, (state, { id }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id && change.status === 'approved'
        ? touch({
            ...change,
            status: 'executing',
            approvals: change.approvals.map((approval) => ({ ...approval, state: 'frozen' })),
            audit: [createAudit('开始执行', '审批记录已冻结，进入执行状态'), ...change.audit],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.toggleStep, (state, { id, stepId }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            steps: change.steps.map((step) =>
              step.id === stepId
                ? {
                    ...step,
                    completed: !step.completed,
                    completedAt: step.completed ? undefined : new Date().toISOString(),
                  }
                : step,
            ),
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.recordDeviation, (state, { id, deviation }) => ({
    ...state,
    changes: state.changes.map((change) =>
      change.id === id
        ? touch({
            ...change,
            deviations: [deviation, ...change.deviations],
            audit: [
              createAudit('记录执行偏离', `${deviation.owner}：${deviation.description}`),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.completeExecution, (state, { id, result, note }) => ({
    ...state,
    // 完成或回滚后释放容量预留
    ledger: { ...state.ledger, reservations: releaseForChange(state.ledger.reservations, id) },
    changes: state.changes.map((change) =>
      change.id === id && change.status === 'executing'
        ? touch({
            ...change,
            status: result,
            reservationIds: [],
            audit: [
              createAudit(
                result === 'completed' ? '执行完成' : '执行回滚',
                `${note}；容量预留已释放`,
              ),
              ...change.audit,
            ],
          })
        : change,
    ),
  })),
  on(ChangeRequestActions.persistSuccess, (state, { snapshotVersion }) => ({
    ...state,
    snapshotVersion,
    persistenceError: null,
  })),
  on(ChangeRequestActions.persistConflict, (state, { stored, localChanges }) => {
    // 后到一方：加载先行写入的最新台账，本地未写入的修改仅保留在冲突记录中，绝不覆盖
    const storedById = new Map(stored.changes.map((change) => [change.id, change]));
    const lostChanges = localChanges.filter((local) => {
      const storedChange = storedById.get(local.id);
      return !storedChange || storedChange.version !== local.version;
    });
    return {
      ...state,
      changes: stored.changes,
      ledger: stored.ledger,
      snapshotVersion: stored.snapshotVersion,
      conflict: {
        at: new Date().toISOString(),
        snapshotVersion: stored.snapshotVersion,
        lostChanges,
      },
    };
  }),
  on(ChangeRequestActions.persistFailure, (state, { message }) => ({
    ...state,
    persistenceError: message,
  })),
  on(ChangeRequestActions.dismissConflict, (state) => ({ ...state, conflict: null })),
  on(ChangeRequestActions.dismissCapacityError, (state) => ({ ...state, capacityError: null })),
  on(ChangeRequestActions.remoteSnapshotLoaded, (state, { snapshot }) => ({
    ...state,
    changes: snapshot.changes,
    ledger: snapshot.ledger,
    snapshotVersion: snapshot.snapshotVersion,
  })),
);
