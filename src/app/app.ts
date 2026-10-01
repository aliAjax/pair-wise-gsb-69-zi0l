import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { Store } from '@ngrx/store';
import { ChangeRequestActions } from './store/change-request.actions';
import {
  selectAllChanges,
  selectConflict,
  selectPersistenceError,
  selectSnapshotVersion,
} from './store/change-request.selectors';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ClarityModule],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly store = inject(Store);
  protected readonly changes = this.store.selectSignal(selectAllChanges);
  protected readonly conflict = this.store.selectSignal(selectConflict);
  protected readonly persistenceError = this.store.selectSignal(selectPersistenceError);
  protected readonly snapshotVersion = this.store.selectSignal(selectSnapshotVersion);

  constructor() {
    this.store.dispatch(ChangeRequestActions.loadChanges());
  }

  protected dismissConflict(): void {
    this.store.dispatch(ChangeRequestActions.dismissConflict());
  }

  protected retryPersist(): void {
    this.store.dispatch(ChangeRequestActions.retryPersist());
  }
}
