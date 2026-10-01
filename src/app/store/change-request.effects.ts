import { inject, Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { catchError, map, of, switchMap, withLatestFrom } from 'rxjs';
import { ChangeRequestService } from '../services/change-request.service';
import { ChangeRequestActions } from './change-request.actions';
import { selectChangeRequestState } from './change-request.selectors';

@Injectable()
export class ChangeRequestEffects {
  private readonly actions$ = inject(Actions);
  private readonly service = inject(ChangeRequestService);
  private readonly store = inject(Store);

  loadChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(ChangeRequestActions.loadChanges),
      switchMap(() =>
        this.service.load().pipe(
          map((snapshot) => ChangeRequestActions.loadChangesSuccess({ snapshot })),
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

  /**
   * 每次状态变更后做比较并交换写入：
   * 版本一致才落盘；发现其他标签页已先行写入时派发冲突，
   * 由 reducer 加载最新台账，本标签页的修改绝不覆盖对方。
   */
  persistChanges$ = createEffect(() =>
    this.actions$.pipe(
      ofType(
        ChangeRequestActions.createChange,
        ChangeRequestActions.updateChange,
        ChangeRequestActions.deleteDraft,
        ChangeRequestActions.submitForReview,
        ChangeRequestActions.approveStage,
        ChangeRequestActions.rejectStage,
        ChangeRequestActions.startExecution,
        ChangeRequestActions.toggleStep,
        ChangeRequestActions.recordDeviation,
        ChangeRequestActions.completeExecution,
        ChangeRequestActions.retryPersist,
      ),
      withLatestFrom(this.store.select(selectChangeRequestState)),
      map(([, state]) => {
        const result = this.service.write(state.snapshotVersion, state.changes, state.ledger);
        if (result.ok) {
          return ChangeRequestActions.persistSuccess({ snapshotVersion: result.snapshotVersion });
        }
        if (result.reason === 'conflict') {
          return ChangeRequestActions.persistConflict({
            stored: result.stored,
            localChanges: state.changes,
          });
        }
        return ChangeRequestActions.persistFailure({ message: result.message });
      }),
    ),
  );

  /** 其他标签页写入快照后，本标签页实时加载最新变更与容量台账 */
  syncRemoteSnapshot$ = createEffect(() =>
    this.service
      .watchStorage()
      .pipe(map((snapshot) => ChangeRequestActions.remoteSnapshotLoaded({ snapshot }))),
  );
}
