import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Action, Store } from '@ngrx/store';
import { Observable, catchError, concatMap, defer, filter, first, map, of, switchMap, withLatestFrom } from 'rxjs';
import { LedgerDocument } from '../models/ledger.model';
import { LedgerService } from '../services/ledger.service';
import { ChangeRequestActions } from './change-request.actions';
import { CommitAction, CommitResult, commit } from './change-request.transitions';
import { selectDocument } from './change-request.selectors';

type CommitOutcome =
  | { kind: 'success'; document: LedgerDocument; changeId?: string }
  | { kind: 'conflict'; document: LedgerDocument; changeId: string; latestVersion: number; latestUpdatedAt: string }
  | { kind: 'capacity'; changeId: string; issues: Extract<CommitResult, { ok: false; reason: 'capacity' }>['issues'] }
  | { kind: 'persist-failure'; message: string };

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly ledger = inject(LedgerService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      switchMap(() =>
        this.ledger.load().pipe(
          map((document) => ChangeRequestActions.loadChangesSuccess({ document })),
          catchError((error: unknown) =>
            of(
              ChangeRequestActions.loadChangesFailure({
                error: error instanceof Error ? error.message : '变更数据加载失败',
              }),
            ),
          ),
        ),
      ),
    ),
  );

  saveChange$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.saveChangeRequested),
      concatMap(({ change, submit }) =>
        this.runCommit({ type: 'save', change, submit }).pipe(
          map((outcome) => this.saveOutcomeToAction(change.id, outcome)),
        ),
      ),
    ),
  );

  commitChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        ChangeRequestActions.deleteDraft,
        ChangeRequestActions.submitForReview,
        ChangeRequestActions.approveStage,
        ChangeRequestActions.rejectStage,
        ChangeRequestActions.startExecution,
        ChangeRequestActions.toggleStep,
        ChangeRequestActions.recordDeviation,
        ChangeRequestActions.completeExecution,
      ),
      concatMap((action) =>
        this.runCommit(toCommitAction(action)).pipe(
          map((outcome) => this.commitOutcomeToAction(outcome)),
        ),
      ),
    ),
  );

  externalSync$ = createEffect(() =>
    this.ledger.externalWrites$.pipe(
      withLatestFrom(this.store.select(selectDocument)),
      filter(([incoming, current]) => incoming.revision > current.revision),
      map(([incoming]) => ChangeRequestActions.externalSync({ document: incoming })),
    ),
  );

  /**
   * 统一提交流水线：读取本地最新台账 → 纯函数校验与流转 → 原子写入。
   * 串行处理（concatMap）保证多标签页与快速连续操作不会乱序落账。
   */
  private runCommit(action: CommitAction): Observable<CommitOutcome> {
    return this.store.select(selectDocument).pipe(
      first(),
      concatMap((fallback) =>
        defer(() => {
          const document = this.ledger.readStored() ?? fallback;
          const result = commit(document, action);
          if (!result.ok) {
            return of(this.failureToOutcome(document, result));
          }
          if (!result.changed) {
            return of<CommitOutcome>({ kind: 'success', document: result.document, changeId: result.changeId });
          }
          try {
            this.ledger.write(result.document);
            return of<CommitOutcome>({ kind: 'success', document: result.document, changeId: result.changeId });
          } catch (error) {
            return of<CommitOutcome>({
              kind: 'persist-failure',
              message: `写入本地台账失败：${error instanceof Error ? error.message : '存储不可用'}。修改未保存，请重试。`,
            });
          }
        }),
      ),
    );
  }

  private failureToOutcome(
    document: LedgerDocument,
    result: Extract<CommitResult, { ok: false }>,
  ): CommitOutcome {
    if (result.reason === 'conflict') {
      return {
        kind: 'conflict',
        document,
        changeId: result.changeId,
        latestVersion: result.latest.version,
        latestUpdatedAt: result.latest.updatedAt,
      };
    }
    return { kind: 'capacity', changeId: result.changeId, issues: result.issues };
  }

  private saveOutcomeToAction(changeId: string, outcome: CommitOutcome): Action {
    switch (outcome.kind) {
      case 'success':
        return ChangeRequestActions.saveChangeSuccess({ document: outcome.document, changeId });
      case 'conflict':
        return ChangeRequestActions.saveChangeConflict({
          document: outcome.document,
          changeId: outcome.changeId,
          latestVersion: outcome.latestVersion,
          latestUpdatedAt: outcome.latestUpdatedAt,
        });
      case 'capacity':
        return ChangeRequestActions.saveChangeRejected({ changeId: outcome.changeId, issues: outcome.issues });
      case 'persist-failure':
        return ChangeRequestActions.persistFailure({ message: outcome.message });
    }
  }

  private commitOutcomeToAction(outcome: CommitOutcome): Action {
    switch (outcome.kind) {
      case 'success':
        return ChangeRequestActions.commitSuccess({ document: outcome.document });
      case 'conflict':
        // 非保存类操作基于最新台账重放，不会产生冲突；兜底按成功同步。
        return ChangeRequestActions.commitSuccess({ document: outcome.document });
      case 'capacity':
        return ChangeRequestActions.commitRejected({ changeId: outcome.changeId, issues: outcome.issues });
      case 'persist-failure':
        return ChangeRequestActions.persistFailure({ message: outcome.message });
    }
  }
}

function toCommitAction(
  action:
    | ReturnType<typeof ChangeRequestActions.deleteDraft>
    | ReturnType<typeof ChangeRequestActions.submitForReview>
    | ReturnType<typeof ChangeRequestActions.approveStage>
    | ReturnType<typeof ChangeRequestActions.rejectStage>
    | ReturnType<typeof ChangeRequestActions.startExecution>
    | ReturnType<typeof ChangeRequestActions.toggleStep>
    | ReturnType<typeof ChangeRequestActions.recordDeviation>
    | ReturnType<typeof ChangeRequestActions.completeExecution>,
): CommitAction {
  switch (action.type) {
    case ChangeRequestActions.deleteDraft.type:
      return { type: 'deleteDraft', id: action.id };
    case ChangeRequestActions.submitForReview.type:
      return { type: 'submit', id: action.id };
    case ChangeRequestActions.approveStage.type:
      return { type: 'approve', id: action.id, stage: action.stage, approver: action.approver, comment: action.comment };
    case ChangeRequestActions.rejectStage.type:
      return { type: 'reject', id: action.id, stage: action.stage, approver: action.approver, comment: action.comment };
    case ChangeRequestActions.startExecution.type:
      return { type: 'startExecution', id: action.id };
    case ChangeRequestActions.toggleStep.type:
      return { type: 'toggleStep', id: action.id, stepId: action.stepId };
    case ChangeRequestActions.recordDeviation.type:
      return { type: 'recordDeviation', id: action.id, deviation: action.deviation };
    case ChangeRequestActions.completeExecution.type:
      return { type: 'completeExecution', id: action.id, result: action.result, note: action.note };
  }
}
