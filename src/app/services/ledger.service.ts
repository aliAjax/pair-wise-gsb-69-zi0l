import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable, forkJoin, map, of, tap } from 'rxjs';
import { CapacityPool, DEFAULT_POOLS } from '../models/capacity.model';
import { ChangeRequest } from '../models/change-request.model';
import { LedgerDocument, migrateDocument, seedDocument } from '../models/ledger.model';

const STORAGE_KEY = 'pair-wise-gsb-69-ledger';
const LEGACY_STORAGE_KEY = 'pair-wise-gsb-69-changes';

/**
 * 台账存储：变更计划、容量预留、审批状态合为一份文档原子写入。
 * 任一环节写入失败都不会留下半成品，重开浏览器后按最近一致版本恢复。
 */
@Injectable({ providedIn: 'root' })
export class LedgerService {
  private readonly http = inject(HttpClient);

  load(): Observable<LedgerDocument> {
    const stored = this.readStored();
    if (stored) {
      return of(stored);
    }
    return forkJoin({
      changes: this.http.get<ChangeRequest[]>('/mock/change-requests.json'),
      pools: this.http.get<CapacityPool[]>('/mock/capacity-pools.json'),
    }).pipe(
      map(({ changes, pools }) => seedDocument(changes, pools.length ? pools : DEFAULT_POOLS)),
      tap((document) => this.write(document)),
    );
  }

  /** 读取本地最新台账；读取失败返回 null，由调用方回退到内存态。 */
  readStored(): LedgerDocument | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return migrateDocument(JSON.parse(raw));
      }
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const migrated = seedDocument(JSON.parse(legacy) as ChangeRequest[], DEFAULT_POOLS);
        this.write(migrated);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 原子写入整份台账文档；失败时抛错，由上层保留草稿并提示重试。 */
  write(document: LedgerDocument): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  }

  /** 其他标签页写入后推送最新台账，保证后到一方看到的是最新数据。 */
  readonly externalWrites$: Observable<LedgerDocument> = new Observable((subscriber) => {
    const handler = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) {
        return;
      }
      try {
        subscriber.next(migrateDocument(JSON.parse(event.newValue)));
      } catch {
        // 忽略无法解析的外部写入，等待下一次同步。
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  });
}
