import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, filter, forkJoin, fromEvent, map, Observable, of, tap } from 'rxjs';
import {
  CapacityLedger,
  WorkspaceSnapshot,
  createDefaultLedger,
  evaluateWrite,
  migrateSnapshot,
} from '../models/capacity.model';
import { ChangeRequest } from '../models/change-request.model';

const SNAPSHOT_KEY = 'pair-wise-gsb-69-workspace';
const LEGACY_CHANGES_KEY = 'pair-wise-gsb-69-changes';

export type WriteResult =
  | { ok: true; snapshotVersion: number }
  | { ok: false; reason: 'conflict'; stored: WorkspaceSnapshot }
  | { ok: false; reason: 'error'; message: string };

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
  private readonly http = inject(HttpClient);

  load(): Observable<WorkspaceSnapshot> {
    const local = this.readSnapshot();
    if (local) {
      return of(local);
    }

    return forkJoin({
      changes: this.http.get<ChangeRequest[]>('/mock/change-requests.json'),
      ledger: this.http.get<CapacityLedger>('/mock/capacity-ledger.json'),
    }).pipe(
      map(({ changes, ledger }) =>
        migrateSnapshot({ changes, ledger, snapshotVersion: 0 }),
      ),
      tap((snapshot) => this.writeRaw(snapshot)),
      catchError((error: unknown) => {
        console.error('Failed to load change requests', error);
        return of(
          migrateSnapshot({ changes: [], ledger: createDefaultLedger(), snapshotVersion: 0 }),
        );
      }),
    );
  }

  /**
   * 比较并交换写入：先重读存储中的快照版本，与本标签页基线不一致时
   * 判定为版本冲突，直接返回对方快照，绝不覆盖先行写入的结果。
   */
  write(expectedVersion: number, changes: ChangeRequest[], ledger: CapacityLedger): WriteResult {
    const stored = this.readSnapshot();
    const decision = evaluateWrite(expectedVersion, stored);
    if (!decision.allowed && stored) {
      return { ok: false, reason: 'conflict', stored };
    }

    const next: WorkspaceSnapshot = { changes, ledger, snapshotVersion: decision.nextVersion };
    try {
      this.writeRaw(next);
      return { ok: true, snapshotVersion: next.snapshotVersion };
    } catch (error: unknown) {
      return {
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : '本地存储写入失败',
      };
    }
  }

  /** 其他标签页写入快照时推送最新台账，用于跨标签页同步台账 */
  watchStorage(): Observable<WorkspaceSnapshot> {
    return fromEvent<StorageEvent>(window, 'storage').pipe(
      filter((event) => event.key === SNAPSHOT_KEY && !!event.newValue),
      map((event) => {
        try {
          return migrateSnapshot(JSON.parse(event.newValue as string) as WorkspaceSnapshot);
        } catch {
          return null;
        }
      }),
      filter((snapshot): snapshot is WorkspaceSnapshot => snapshot !== null),
    );
  }

  private readSnapshot(): WorkspaceSnapshot | null {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (raw) {
      try {
        return migrateSnapshot(JSON.parse(raw) as WorkspaceSnapshot);
      } catch {
        localStorage.removeItem(SNAPSHOT_KEY);
        return null;
      }
    }

    // 兼容旧版本仅保存变更数组的存储
    const legacy = localStorage.getItem(LEGACY_CHANGES_KEY);
    if (legacy) {
      try {
        const changes = JSON.parse(legacy) as ChangeRequest[];
        localStorage.removeItem(LEGACY_CHANGES_KEY);
        return migrateSnapshot({ changes, ledger: createDefaultLedger(), snapshotVersion: 0 });
      } catch {
        localStorage.removeItem(LEGACY_CHANGES_KEY);
      }
    }
    return null;
  }

  private writeRaw(snapshot: WorkspaceSnapshot): void {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  }

  exportRetrospective(change: ChangeRequest): string {
    const lines = [
      `# ${change.id} ${change.title} 复盘记录`,
      '',
      `状态：${change.status}`,
      `负责人：${change.owner}`,
      `窗口：${change.window.start} - ${change.window.end}`,
      `风险等级：${change.risk}`,
      '',
      '## 执行偏离',
      ...(change.deviations.length
        ? change.deviations.map(
            (item) =>
              `- ${item.recordedAt} ${item.owner} [${item.decision}] ${item.description}`,
          )
        : ['- 无']),
      '',
      '## 审计轨迹',
      ...change.audit.map(
        (item) => `- ${item.timestamp} ${item.actor} ${item.action}：${item.detail}`,
      ),
    ];
    return lines.join('\n');
  }
}
