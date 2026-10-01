import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  CapacityLedger,
  CapacityPool,
  CAPACITY_HOLDING_STATUSES,
} from '../../models/capacity.model';
import { ChangeRequest } from '../../models/change-request.model';

interface PoolView {
  pool: CapacityPool;
  rackUnits: number;
  networkGbps: number;
  serviceSlots: number;
  criticalCount: number;
}

@Component({
  selector: 'app-capacity-ledger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <div class="pool-grid">
      @for (view of poolViews(); track view.pool.datacenterId) {
        <article class="pool-card">
          <header>
            <strong>{{ view.pool.datacenterName }}</strong>
            <span>{{ view.pool.datacenterId }}</span>
          </header>
          <div class="meter-row">
            <span>机柜</span>
            <div class="meter">
              <div
                class="meter-fill"
                [class.hot]="isHot(view.rackUnits, view.pool.rackUnits)"
                [style.width.%]="percent(view.rackUnits, view.pool.rackUnits)"
              ></div>
            </div>
            <em>{{ view.rackUnits }} / {{ view.pool.rackUnits }}U</em>
          </div>
          <div class="meter-row">
            <span>网络</span>
            <div class="meter">
              <div
                class="meter-fill"
                [class.hot]="isHot(view.networkGbps, view.pool.networkGbps)"
                [style.width.%]="percent(view.networkGbps, view.pool.networkGbps)"
              ></div>
            </div>
            <em>{{ view.networkGbps }} / {{ view.pool.networkGbps }}Gbps</em>
          </div>
          <div class="meter-row">
            <span>服务</span>
            <div class="meter">
              <div
                class="meter-fill"
                [class.hot]="isHot(view.serviceSlots, view.pool.serviceSlots)"
                [style.width.%]="percent(view.serviceSlots, view.pool.serviceSlots)"
              ></div>
            </div>
            <em>{{ view.serviceSlots }} / {{ view.pool.serviceSlots }} 实例</em>
          </div>
          <footer>
            <span
              class="critical-slots"
              [class.full]="view.criticalCount >= view.pool.maxCriticalChanges"
            >
              严重变更 {{ view.criticalCount }} / {{ view.pool.maxCriticalChanges }}
            </span>
            <span>当前持有预留</span>
          </footer>
        </article>
      }
    </div>

    <table class="reservation-table">
      <thead>
        <tr>
          <th>预留号</th>
          <th>变更</th>
          <th>机房</th>
          <th>窗口</th>
          <th>容量</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        @for (reservation of recentReservations(); track reservation.id) {
          <tr [class.released]="reservation.status === 'released'">
            <td>{{ reservation.id }}</td>
            <td>{{ reservation.changeId }}</td>
            <td>{{ poolName(reservation.datacenterId) }}</td>
            <td>
              {{ reservation.window.start | date: 'MM-dd HH:mm' }} 至
              {{ reservation.window.end | date: 'MM-dd HH:mm' }}
            </td>
            <td>
              机柜 {{ reservation.demand.rackUnits }}U · 网络
              {{ reservation.demand.networkGbps }}Gbps · 服务
              {{ reservation.demand.serviceSlots }} 实例
            </td>
            <td>
              <span class="reservation-status" [class]="reservation.status">
                {{ reservation.status === 'reserved' ? '预留中' : '已释放' }}
              </span>
            </td>
          </tr>
        } @empty {
          <tr>
            <td colspan="6" class="empty-row">暂无容量预留记录。</td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: [
    `
      .pool-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 14px;
        padding: 16px 18px;
      }

      .pool-card {
        padding: 14px 16px;
        border: 1px solid #d7d7d7;
        background: #fafbfc;
      }

      .pool-card header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: 12px;
      }

      .pool-card header span {
        color: #737373;
        font-size: 11px;
      }

      .meter-row {
        display: grid;
        grid-template-columns: 34px 1fr auto;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
        font-size: 12px;
      }

      .meter-row em {
        color: #555;
        font-style: normal;
        font-size: 11px;
      }

      .meter {
        height: 8px;
        background: #e4e4e4;
      }

      .meter-fill {
        height: 100%;
        background: #4b8d65;
      }

      .meter-fill.hot {
        background: #c21d00;
      }

      .pool-card footer {
        display: flex;
        justify-content: space-between;
        margin-top: 10px;
        color: #737373;
        font-size: 11px;
      }

      .critical-slots {
        padding: 1px 6px;
        border: 1px solid #8fb99f;
        background: #edf7f0;
        color: #286140;
      }

      .critical-slots.full {
        border-color: #d58d7e;
        background: #fbece8;
        color: #8e260f;
      }

      .reservation-table {
        width: 100%;
        border-collapse: collapse;
        text-align: left;
        font-size: 12px;
      }

      .reservation-table th {
        padding: 8px 18px;
        border-top: 1px solid #d7d7d7;
        border-bottom: 1px solid #d7d7d7;
        background: #f7f8f8;
        color: #666;
        font-size: 11px;
      }

      .reservation-table td {
        padding: 10px 18px;
        border-bottom: 1px solid #e4e4e4;
      }

      .reservation-table tr.released td {
        color: #9a9a9a;
      }

      .reservation-status {
        padding: 1px 6px;
        border: 1px solid #5688a5;
        background: #eaf4f9;
        color: #215a78;
        font-size: 11px;
      }

      .reservation-status.released {
        border-color: #a4a4a4;
        background: #f2f2f2;
        color: #666;
      }

      .empty-row {
        padding: 24px 18px !important;
        text-align: center;
        color: #737373;
      }
    `,
  ],
})
export class CapacityLedgerComponent {
  readonly ledger = input.required<CapacityLedger>();
  readonly changes = input.required<ChangeRequest[]>();

  /** 各机房当前持有的有效预留合计与严重变更占用数 */
  readonly poolViews = computed<PoolView[]>(() => {
    const changes = this.changes();
    return this.ledger().pools.map((pool) => {
      const active = this.ledger().reservations.filter(
        (reservation) =>
          reservation.status === 'reserved' && reservation.datacenterId === pool.datacenterId,
      );
      const criticalCount = changes.filter(
        (change) =>
          change.risk === 'critical' &&
          CAPACITY_HOLDING_STATUSES.includes(change.status) &&
          change.capacity.datacenterId === pool.datacenterId,
      ).length;
      return {
        pool,
        rackUnits: active.reduce((sum, item) => sum + item.demand.rackUnits, 0),
        networkGbps: active.reduce((sum, item) => sum + item.demand.networkGbps, 0),
        serviceSlots: active.reduce((sum, item) => sum + item.demand.serviceSlots, 0),
        criticalCount,
      };
    });
  });

  readonly recentReservations = computed(() =>
    [...this.ledger().reservations]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 10),
  );

  poolName(datacenterId: string): string {
    return (
      this.ledger().pools.find((pool) => pool.datacenterId === datacenterId)
        ?.datacenterName ?? datacenterId
    );
  }

  percent(used: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  }

  isHot(used: number, total: number): boolean {
    return total > 0 && used / total >= 0.8;
  }
}
