import {
  CapacityIssue,
  OCCUPYING_STATUSES,
  buildReservations,
  checkCapacity,
  checkCriticalLimit,
  computeDemand,
  occupiedDatacenters,
  releaseReservations,
} from '../models/capacity.model';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
  APPROVAL_ORDER,
  createAudit,
  createEmptyApprovals,
} from '../models/change-request.model';
import { LedgerDocument } from '../models/ledger.model';

export type CommitAction =
  | { type: 'save'; change: ChangeRequest; submit: boolean }
  | { type: 'deleteDraft'; id: string }
  | { type: 'submit'; id: string }
  | { type: 'approve'; id: string; stage: ApprovalStage; approver: string; comment: string }
  | { type: 'reject'; id: string; stage: ApprovalStage; approver: string; comment: string }
  | { type: 'startExecution'; id: string }
  | { type: 'toggleStep'; id: string; stepId: string }
  | { type: 'recordDeviation'; id: string; deviation: DeviationRecord }
  | { type: 'completeExecution'; id: string; result: 'completed' | 'rolled_back'; note: string };

export type CommitResult =
  | { ok: true; document: LedgerDocument; changed: boolean; changeId?: string }
  | { ok: false; reason: 'conflict'; changeId: string; latest: ChangeRequest }
  | { ok: false; reason: 'capacity'; changeId: string; issues: CapacityIssue[] };

const CONTENT_KEYS = [
  'title',
  'summary',
  'owner',
  'onCall',
  'risk',
  'resources',
  'steps',
  'window',
] as const;

function sameContent(left: ChangeRequest, right: ChangeRequest): boolean {
  return CONTENT_KEYS.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

function touch(change: ChangeRequest, now: Date): ChangeRequest {
  return { ...change, version: change.version + 1, updatedAt: now.toISOString() };
}

function nextPendingStage(change: ChangeRequest): ApprovalStage | null {
  return (
    APPROVAL_ORDER.find((stage) =>
      change.approvals.some((approval) => approval.stage === stage && approval.state === 'pending'),
    ) ?? null
  );
}

function replaceChange(document: LedgerDocument, next: ChangeRequest): LedgerDocument {
  const exists = document.changes.some((change) => change.id === next.id);
  return {
    ...document,
    revision: document.revision + 1,
    changes: exists
      ? document.changes.map((change) => (change.id === next.id ? next : change))
      : [next, ...document.changes],
  };
}

function noOp(document: LedgerDocument): CommitResult {
  return { ok: true, document, changed: false };
}

/**
 * 容量门禁：严重变更同机房同时段最多 2 项；
 * 机柜、网络、服务容量必须先预留成功才允许写入。
 */
function gateFor(change: ChangeRequest, document: LedgerDocument): CapacityIssue[] {
  const demand = computeDemand(change, document.pools);
  return [
    ...checkCriticalLimit(
      change,
      document.changes,
      occupiedDatacenters(change, document.pools),
      document.pools,
    ),
    ...checkCapacity(demand, change.window, document.pools, document.reservations, change.id),
  ];
}

/** 占用容量的变更：先释放旧预留，门禁通过后按最新方案重新预留。 */
function reserveFor(document: LedgerDocument, change: ChangeRequest, now: Date): CommitResult {
  const issues = gateFor(change, document);
  if (issues.length > 0) {
    return { ok: false, reason: 'capacity', changeId: change.id, issues };
  }
  const reservations = [
    ...releaseReservations(document.reservations, change.id, now.toISOString()),
    ...buildReservations(change, document.pools, now.toISOString()),
  ];
  return { ok: true, document: { ...replaceChange(document, change), reservations }, changed: true, changeId: change.id };
}

function applySave(
  document: LedgerDocument,
  incoming: ChangeRequest,
  submit: boolean,
  now: Date,
): CommitResult {
  const stored = document.changes.find((change) => change.id === incoming.id);

  // 乐观并发：另一标签页已先行写入时，后到一方不得覆盖。
  if (stored && stored.version !== incoming.version) {
    return { ok: false, reason: 'conflict', changeId: incoming.id, latest: stored };
  }

  const contentChanged = !stored || !sameContent(stored, incoming);
  if (stored && !contentChanged && !submit) {
    return noOp(document);
  }

  let next: ChangeRequest = touch({ ...incoming }, now);
  const audit: ReturnType<typeof createAudit>[] = [];

  if (!stored) {
    audit.push(createAudit('创建草稿', `创建变更 ${next.id}`));
  } else if (contentChanged) {
    audit.push(createAudit('保存变更方案', '更新资源、步骤或窗口信息'));
  }

  if (submit && ['draft', 'rejected'].includes(next.status)) {
    next = { ...next, status: 'submitted', approvals: createEmptyApprovals() };
    audit.push(createAudit('提交审批', '容量预留成功，进入网络、系统、安全、业务顺序会签'));
  } else if (
    stored &&
    contentChanged &&
    (stored.status === 'submitted' || stored.status === 'approved')
  ) {
    // 审批中的计划被修改：旧会签失效，从网络负责人重新会签。
    next = { ...next, status: 'submitted', approvals: createEmptyApprovals() };
    audit.push(
      createAudit('会签重置', '审批中的方案被修改，既有会签失效，从网络负责人重新开始会签'),
    );
  }

  next = { ...next, audit: [...audit.reverse(), ...next.audit] };

  if (OCCUPYING_STATUSES.includes(next.status)) {
    return reserveFor(document, next, now);
  }
  const reservations = releaseReservations(document.reservations, next.id, now.toISOString());
  return { ok: true, document: { ...replaceChange(document, next), reservations }, changed: true, changeId: next.id };
}

function applySubmit(document: LedgerDocument, id: string, now: Date): CommitResult {
  const stored = document.changes.find((change) => change.id === id);
  if (!stored || !['draft', 'rejected'].includes(stored.status)) {
    return noOp(document);
  }
  const next: ChangeRequest = {
    ...touch(stored, now),
    status: 'submitted',
    approvals: createEmptyApprovals(),
    audit: [
      createAudit('提交审批', '容量预留成功，进入网络、系统、安全、业务顺序会签'),
      ...stored.audit,
    ],
  };
  return reserveFor(document, next, now);
}

function applyDeleteDraft(document: LedgerDocument, id: string, now: Date): CommitResult {
  const stored = document.changes.find((change) => change.id === id);
  if (!stored || stored.status !== 'draft') {
    return noOp(document);
  }
  return {
    ok: true,
    document: {
      ...document,
      revision: document.revision + 1,
      changes: document.changes.filter((change) => change.id !== id),
      reservations: releaseReservations(document.reservations, id, now.toISOString()),
    },
    changed: true,
    changeId: id,
  };
}

function applyApprove(
  document: LedgerDocument,
  action: { id: string; stage: ApprovalStage; approver: string; comment: string },
  now: Date,
): CommitResult {
  const stored = document.changes.find((change) => change.id === action.id);
  if (!stored || stored.status !== 'submitted' || nextPendingStage(stored) !== action.stage) {
    return noOp(document);
  }
  const approvals = stored.approvals.map((approval) =>
    approval.stage === action.stage
      ? {
          ...approval,
          state: 'approved' as const,
          approver: action.approver,
          comment: action.comment,
          decidedAt: now.toISOString(),
        }
      : approval,
  );
  const allApproved = approvals.every((approval) => approval.state === 'approved');
  const next: ChangeRequest = {
    ...touch(stored, now),
    status: allApproved ? 'approved' : 'submitted',
    approvals,
    audit: [
      createAudit('阶段会签', `${action.stage} 已由 ${action.approver} 批准：${action.comment}`),
      ...stored.audit,
    ],
  };
  return { ok: true, document: replaceChange(document, next), changed: true, changeId: next.id };
}

function applyReject(
  document: LedgerDocument,
  action: { id: string; stage: ApprovalStage; approver: string; comment: string },
  now: Date,
): CommitResult {
  const stored = document.changes.find((change) => change.id === action.id);
  if (!stored || stored.status !== 'submitted') {
    return noOp(document);
  }
  const next: ChangeRequest = {
    ...touch(stored, now),
    status: 'rejected',
    approvals: stored.approvals.map((approval) =>
      approval.stage === action.stage
        ? {
            ...approval,
            state: 'rejected' as const,
            approver: action.approver,
            comment: action.comment,
            decidedAt: now.toISOString(),
          }
        : approval,
    ),
    audit: [
      createAudit('审批退回', `${action.stage} 由 ${action.approver} 退回：${action.comment}`),
      ...stored.audit,
    ],
  };
  // 退回后不再占用容量。
  const reservations = releaseReservations(document.reservations, next.id, now.toISOString());
  return { ok: true, document: { ...replaceChange(document, next), reservations }, changed: true, changeId: next.id };
}

function applyStartExecution(document: LedgerDocument, id: string, now: Date): CommitResult {
  const stored = document.changes.find((change) => change.id === id);
  if (!stored || stored.status !== 'approved') {
    return noOp(document);
  }
  const next: ChangeRequest = {
    ...touch(stored, now),
    status: 'executing',
    approvals: stored.approvals.map((approval) => ({ ...approval, state: 'frozen' as const })),
    audit: [createAudit('开始执行', '审批记录已冻结，进入执行状态'), ...stored.audit],
  };
  return { ok: true, document: replaceChange(document, next), changed: true, changeId: next.id };
}

function applyToggleStep(
  document: LedgerDocument,
  id: string,
  stepId: string,
  now: Date,
): CommitResult {
  const stored = document.changes.find((change) => change.id === id);
  if (!stored) {
    return noOp(document);
  }
  const next: ChangeRequest = {
    ...touch(stored, now),
    steps: stored.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            completed: !step.completed,
            completedAt: step.completed ? undefined : now.toISOString(),
          }
        : step,
    ),
  };
  return { ok: true, document: replaceChange(document, next), changed: true, changeId: next.id };
}

function applyRecordDeviation(
  document: LedgerDocument,
  id: string,
  deviation: DeviationRecord,
  now: Date,
): CommitResult {
  const stored = document.changes.find((change) => change.id === id);
  if (!stored) {
    return noOp(document);
  }
  const next: ChangeRequest = {
    ...touch(stored, now),
    deviations: [deviation, ...stored.deviations],
    audit: [
      createAudit('记录执行偏离', `${deviation.owner}：${deviation.description}`),
      ...stored.audit,
    ],
  };
  return { ok: true, document: replaceChange(document, next), changed: true, changeId: next.id };
}

function applyCompleteExecution(
  document: LedgerDocument,
  id: string,
  result: 'completed' | 'rolled_back',
  note: string,
  now: Date,
): CommitResult {
  const stored = document.changes.find((change) => change.id === id);
  if (!stored || stored.status !== 'executing') {
    return noOp(document);
  }
  const next: ChangeRequest = {
    ...touch(stored, now),
    status: result,
    audit: [createAudit(result === 'completed' ? '执行完成' : '执行回滚', note), ...stored.audit],
  };
  // 结束后释放容量预留。
  const reservations = releaseReservations(document.reservations, next.id, now.toISOString());
  return { ok: true, document: { ...replaceChange(document, next), reservations }, changed: true, changeId: next.id };
}

export function commit(
  document: LedgerDocument,
  action: CommitAction,
  now: Date = new Date(),
): CommitResult {
  switch (action.type) {
    case 'save':
      return applySave(document, action.change, action.submit, now);
    case 'deleteDraft':
      return applyDeleteDraft(document, action.id, now);
    case 'submit':
      return applySubmit(document, action.id, now);
    case 'approve':
      return applyApprove(document, action, now);
    case 'reject':
      return applyReject(document, action, now);
    case 'startExecution':
      return applyStartExecution(document, action.id, now);
    case 'toggleStep':
      return applyToggleStep(document, action.id, action.stepId, now);
    case 'recordDeviation':
      return applyRecordDeviation(document, action.id, action.deviation, now);
    case 'completeExecution':
      return applyCompleteExecution(document, action.id, action.result, action.note, now);
  }
}
