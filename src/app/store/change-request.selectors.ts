import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ChangeRequestState } from './change-request.reducer';

export const selectChangeRequestState =
  createFeatureSelector<ChangeRequestState>('changeRequests');

export const selectAllChanges = createSelector(
  selectChangeRequestState,
  (state) => state.changes,
);

export const selectLedger = createSelector(selectChangeRequestState, (state) => state.ledger);

export const selectPools = createSelector(selectLedger, (ledger) => ledger.pools);

export const selectSnapshotVersion = createSelector(
  selectChangeRequestState,
  (state) => state.snapshotVersion,
);

export const selectChangesLoading = createSelector(
  selectChangeRequestState,
  (state) => state.loading,
);

export const selectChangesError = createSelector(
  selectChangeRequestState,
  (state) => state.error,
);

export const selectPersistenceError = createSelector(
  selectChangeRequestState,
  (state) => state.persistenceError,
);

export const selectCapacityError = createSelector(
  selectChangeRequestState,
  (state) => state.capacityError,
);

export const selectConflict = createSelector(
  selectChangeRequestState,
  (state) => state.conflict,
);

export const selectChangeById = (id: string) =>
  createSelector(selectAllChanges, (changes) =>
    changes.find((change) => change.id === id),
  );
