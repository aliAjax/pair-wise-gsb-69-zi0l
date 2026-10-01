import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  CAPACITY_TYPE_LABELS,
  CapacityPool,
  CapacityPoolType,
  CapacityReservation,
  MAX_CRITICAL_PER_WINDOW,
} from '../../models/capacity.model';
import { ChangeRequest, RISK_LABELS, STATUS_LABELS } from '../../models/change-request.model';

interface PoolRow {
  pool: CapacityPool;
  peak: number;
  remaining: number;
  ratio: number;
}

interface DatacenterLedger {
  datacenterId: string;
  datacenterName: string;
  rows: PoolRow[];
  criticalCount: number;
}

const POOL_TYPE_ORDER: CapacityPoolType[] = ['rack', 'network', 'service'];

@Component({
  selector: 'app-capacity-ledger-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <div class="ledger-grid">
      @for (dc of ledgers(); track dc.datacenterId) {
        <section class="dc-card">
          <header>
            <strong>{{ dc.datacenterName }}</strong>
            <span
              >严重变更并发上限 {{ maxCritical }} 项 · 当前占用 {{ dc.criticalCount }} 项</span
            >
          </header>
          <table>
            <thead>
              <tr>
                <th>容量池</th>
                <th>总量</th>
                <th>峰值预留</th>
                <th>剩余</th>
                <th>占用</th>
              </tr>
            </thead>
            <tbody>
              @for (row of dc.rows; track row.pool.type) {
                <tr [class.tight]="row.remaining <= 0">
                  <td>{{ typeLabel(row.pool.type) }}</td>
                  <td>{{ row.pool.total }} {{ row.pool.unit }}</td>
                  <td>{{ row.peak }}</td>
                  <td>{{ row.remaining }}</td>
                  <td>
                    <div class="usage-bar">
                      <div class="usage-fill" [style.width.%]="row.ratio * 100"></div>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>

    <div class="reservation-table-wrap">
      <table class="reservation-table">
        <thead>
          <tr>
            <th>变更</th>
            <th>机房</th>
            <th>容量池</th>
            <th>预留量</th>
            <th>占用窗口</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          @for (row of reservationRows(); track row.reservation.id) {
            <tr [class.released]="row.reservation.status === 'released'">
              <td>
                @if (row.change) {
                  <a [routerLink]="['/changes', row.change.id]">
                    {{ row.change.id }} {{ row.change.title }}
                  </a>
                } @else {
                  {{ row.reservation.changeId }}
                }
              </td>
              <td>{{ datacenterName(row.reservation.datacenterId) }}</td>
              <td>{{ typeLabel(row.reservation.type) }}</td>
              <td>{{ row.reservation.amount }}</td>
              <td>
                {{ row.reservation.windowStart | date: 'MM-dd HH:mm' }} 至
                {{ row.reservation.windowEnd | date: 'MM-dd HH:mm' }}
              </td>
              <td>
                <span class="tag" [class]="row.reservation.status">
                  {{ row.reservation.status === 'active' ? '占用中' : '已释放' }}
                </span>
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="6" class="empty">暂无容量预留记录。</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [
    `
      .ledger-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 14px;
        padding: 16px 18px;
      }

      .dc-card {
        border: 1px solid #d7d7d7;
      }

      .dc-card header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 14px;
        border-bottom: 1px solid #e3e3e3;
        background: #f7f8f8;
      }

      .dc-card header span {
        color: #6b6b6b;
        font-size: 11px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        text-align: left;
      }

      th,
      td {
        padding: 8px 14px;
        border-bottom: 1px solid #ececec;
        font-size: 12px;
      }

      th {
        color: #666;
        font-size: 11px;
        font-weight: 600;
      }

      tr.tight td {
        color: #8e260f;
      }

      .usage-bar {
        width: 110px;
        height: 8px;
        background: #ececec;
      }

      .usage-fill {
        height: 100%;
        background: #266c91;
      }

      tr.tight .usage-fill {
        background: #c21d00;
      }

      .reservation-table-wrap {
        max-height: 320px;
        overflow-y: auto;
        border-top: 1px solid #d7d7d7;
      }

      .reservation-table td {
        font-size: 12px;
      }

      tr.released td {
        color: #8a8a8a;
      }

      .tag {
        display: inline-block;
        padding: 1px 7px;
        border: 1px solid #8fb99f;
        background: #edf7f0;
        color: #286140;
        font-size: 11px;
      }

      .tag.released {
        border-color: #b5b5b5;
        background: #f2f2f2;
        color: #5f5f5f;
      }

      .empty {
        padding: 24px !important;
        text-align: center;
        color: #737373;
      }
    `,
  ],
})
export class CapacityLedgerPanelComponent {
  readonly pools = input.required<CapacityPool[]>();
  readonly reservations = input.required<CapacityReservation[]>();
  readonly changes = input.required<ChangeRequest[]>();

  readonly maxCritical = MAX_CRITICAL_PER_WINDOW;

  readonly ledgers = computed<DatacenterLedger[]>(() => {
    const pools = this.pools();
    const reservations = this.reservations();
    const changes = this.changes();
    const datacenterIds = [...new Set(pools.map((pool) => pool.datacenterId))];
    return datacenterIds.map((datacenterId) => {
      const dcPools = pools.filter((pool) => pool.datacenterId === datacenterId);
      const dcReservations = reservations.filter(
        (reservation) =>
          reservation.datacenterId === datacenterId && reservation.status === 'active',
      );
      const rows = POOL_TYPE_ORDER.map((type) => {
        const pool = dcPools.find((candidate) => candidate.type === type);
        if (!pool) {
          return null;
        }
        const peak = peakUsage(
          dcReservations.filter((reservation) => reservation.type === type),
        );
        return {
          pool,
          peak,
          remaining: pool.total - peak,
          ratio: pool.total > 0 ? Math.min(1, peak / pool.total) : 0,
        };
      }).filter((row): row is PoolRow => row !== null);
      const criticalCount = changes.filter(
        (change) =>
          change.risk === 'critical' &&
          ['submitted', 'approved', 'executing'].includes(change.status) &&
          dcReservations.some((reservation) => reservation.changeId === change.id),
      ).length;
      return {
        datacenterId,
        datacenterName: dcPools[0]?.datacenterName ?? datacenterId,
        rows,
        criticalCount,
      };
    });
  });

  readonly reservationRows = computed(() => {
    const byId = new Map(this.changes().map((change) => [change.id, change]));
    return [...this.reservations()]
      .sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === 'active' ? -1 : 1;
        }
        return left.windowStart.localeCompare(right.windowStart);
      })
      .map((reservation) => ({ reservation, change: byId.get(reservation.changeId) }));
  });

  typeLabel(type: CapacityPoolType): string {
    return CAPACITY_TYPE_LABELS[type];
  }

  datacenterName(datacenterId: string): string {
    return (
      this.pools().find((pool) => pool.datacenterId === datacenterId)?.datacenterName ??
      datacenterId
    );
  }

  statusLabel(change: ChangeRequest): string {
    return STATUS_LABELS[change.status];
  }

  riskLabel(change: ChangeRequest): string {
    return RISK_LABELS[change.risk];
  }
}

/** 扫描线求同一容量池的峰值并发预留量。 */
function peakUsage(reservations: CapacityReservation[]): number {
  const events: Array<{ at: string; delta: number }> = [];
  reservations.forEach((reservation) => {
    events.push({ at: reservation.windowStart, delta: reservation.amount });
    events.push({ at: reservation.windowEnd, delta: -reservation.amount });
  });
  events.sort((left, right) => {
    const byTime = left.at.localeCompare(right.at);
    // 同一时刻先处理释放再计入新增，避免边界虚高。
    return byTime !== 0 ? byTime : left.delta - right.delta;
  });
  let current = 0;
  let peak = 0;
  events.forEach((event) => {
    current += event.delta;
    peak = Math.max(peak, current);
  });
  return peak;
}
