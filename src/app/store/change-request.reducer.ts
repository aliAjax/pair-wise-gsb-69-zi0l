import { createReducer, on } from '@ngrx/store';
import { CapacityIssue } from '../models/capacity.model';
import { EMPTY_DOCUMENT, LedgerDocument } from '../models/ledger.model';
import { ChangeRequestActions } from './change-request.actions';

export interface CommitNotice {
  kind: 'conflict' | 'capacity' | 'persist-failure';
  changeId?: string;
  message: string;
  issues?: CapacityIssue[];
  latestVersion?: number;
  latestUpdatedAt?: string;
}

export interface ChangeRequestState {
  document: LedgerDocument;
  loading: boolean;
  error: string | null;
  notice: CommitNotice | null;
}

export const initialChangeRequestState: ChangeRequestState = {
  document: EMPTY_DOCUMENT,
  loading: false,
  error: null,
  notice: null,
};

export const changeRequestReducer = createReducer(
  initialChangeRequestState,
  on(ChangeRequestActions.loadChanges, (state) => ({ ...state, loading: true, error: null })),
  on(ChangeRequestActions.loadChangesSuccess, (state, { document }) => ({
    ...state,
    document,
    loading: false,
    notice: null,
  })),
  on(ChangeRequestActions.loadChangesFailure, (state, { error }) => ({
    ...state,
    loading: false,
    error,
  })),
  on(ChangeRequestActions.saveChangeSuccess, (state, { document }) => ({
    ...state,
    document,
    notice: null,
  })),
  on(ChangeRequestActions.saveChangeRejected, (state, { changeId, issues }) => ({
    ...state,
    notice: {
      kind: 'capacity',
      changeId,
      message: '容量不足或超出严重变更并发限制，本次提交已被拒绝，草稿已保留。',
      issues,
    },
  })),
  on(ChangeRequestActions.saveChangeConflict, (state, { document, changeId, latestVersion, latestUpdatedAt }) => ({
    ...state,
    document,
    notice: {
      kind: 'conflict',
      changeId,
      message: `另一窗口已保存更新的版本（v${latestVersion}），你的修改未写入，请基于最新台账处理。`,
      latestVersion,
      latestUpdatedAt,
    },
  })),
  on(ChangeRequestActions.commitSuccess, (state, { document }) => ({
    ...state,
    document,
    notice: null,
  })),
  on(ChangeRequestActions.commitRejected, (state, { changeId, issues }) => ({
    ...state,
    notice: {
      kind: 'capacity',
      changeId,
      message: '容量不足或超出严重变更并发限制，提交被拒绝，当前方案保持原状。',
      issues,
    },
  })),
  on(ChangeRequestActions.persistFailure, (state, { message }) => ({
    ...state,
    notice: {
      kind: 'persist-failure',
      message,
    },
  })),
  on(ChangeRequestActions.externalSync, (state, { document }) => ({
    ...state,
    document,
  })),
  on(ChangeRequestActions.dismissNotice, (state) => ({ ...state, notice: null })),
);
