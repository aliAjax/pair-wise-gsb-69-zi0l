import { createFeatureSelector, createSelector } from '@ngrx/store';
import { ChangeRequestState } from './change-request.reducer';

export const selectChangeRequestState =
  createFeatureSelector<ChangeRequestState>('changeRequests');

export const selectDocument = createSelector(
  selectChangeRequestState,
  (state) => state.document,
);

export const selectAllChanges = createSelector(
  selectDocument,
  (document) => document.changes,
);

export const selectReservations = createSelector(
  selectDocument,
  (document) => document.reservations,
);

export const selectPools = createSelector(selectDocument, (document) => document.pools);

export const selectNotice = createSelector(selectChangeRequestState, (state) => state.notice);

export const selectChangesLoading = createSelector(
  selectChangeRequestState,
  (state) => state.loading,
);

export const selectChangesError = createSelector(
  selectChangeRequestState,
  (state) => state.error,
);

export const selectChangeById = (id: string) =>
  createSelector(selectAllChanges, (changes) =>
    changes.find((change) => change.id === id),
  );

export const selectReservationsByChange = (changeId: string) =>
  createSelector(selectReservations, (reservations) =>
    reservations.filter((reservation) => reservation.changeId === changeId),
  );
