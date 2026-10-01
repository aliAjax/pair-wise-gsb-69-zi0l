import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { CapacityIssue } from '../models/capacity.model';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
} from '../models/change-request.model';
import { LedgerDocument } from '../models/ledger.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ document: LedgerDocument }>(),
    'Load Changes Failure': props<{ error: string }>(),

    // 保存（新建 / 编辑）：先过容量门禁与版本检查，成功才落账。
    'Save Change Requested': props<{ change: ChangeRequest; submit: boolean }>(),
    'Save Change Success': props<{ document: LedgerDocument; changeId: string }>(),
    'Save Change Rejected': props<{ changeId: string; issues: CapacityIssue[] }>(),
    'Save Change Conflict': props<{
      document: LedgerDocument;
      changeId: string;
      latestVersion: number;
      latestUpdatedAt: string;
    }>(),

    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Reject Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Start Execution': props<{ id: string }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    'Record Deviation': props<{ id: string; deviation: DeviationRecord }>(),
    'Complete Execution': props<{ id: string; result: 'completed' | 'rolled_back'; note: string }>(),

    // 非保存类变更的落账结果。
    'Commit Success': props<{ document: LedgerDocument }>(),
    'Commit Rejected': props<{ changeId: string; issues: CapacityIssue[] }>(),
    'Persist Failure': props<{ message: string }>(),

    // 其他标签页写入后的台账同步。
    'External Sync': props<{ document: LedgerDocument }>(),
    'Dismiss Notice': emptyProps(),
  },
});
