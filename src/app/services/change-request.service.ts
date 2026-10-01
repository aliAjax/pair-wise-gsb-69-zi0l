import { Injectable } from '@angular/core';
import { ChangeRequest } from '../models/change-request.model';

@Injectable({ providedIn: 'root' })
export class ChangeRequestService {
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
