import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { WorkspaceSnapshot } from '../models/capacity.model';
import {
  ApprovalStage,
  ChangeRequest,
  DeviationRecord,
} from '../models/change-request.model';

export const ChangeRequestActions = createActionGroup({
  source: 'Change Request',
  events: {
    'Load Changes': emptyProps(),
    'Load Changes Success': props<{ snapshot: WorkspaceSnapshot }>(),
    'Load Changes Failure': props<{ error: string }>(),
    'Create Change': props<{ change: ChangeRequest }>(),
    'Update Change': props<{ change: ChangeRequest }>(),
    'Delete Draft': props<{ id: string }>(),
    'Submit For Review': props<{ id: string }>(),
    'Approve Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Reject Stage': props<{ id: string; stage: ApprovalStage; approver: string; comment: string }>(),
    'Start Execution': props<{ id: string }>(),
    'Toggle Step': props<{ id: string; stepId: string }>(),
    'Record Deviation': props<{ id: string; deviation: DeviationRecord }>(),
    'Complete Execution': props<{ id: string; result: 'completed' | 'rolled_back'; note: string }>(),
    'Persist Success': props<{ snapshotVersion: number }>(),
    'Persist Conflict': props<{ stored: WorkspaceSnapshot; localChanges: ChangeRequest[] }>(),
    'Persist Failure': props<{ message: string }>(),
    'Retry Persist': emptyProps(),
    'Dismiss Conflict': emptyProps(),
    'Dismiss Capacity Error': emptyProps(),
    'Remote Snapshot Loaded': props<{ snapshot: WorkspaceSnapshot }>(),
  },
});
