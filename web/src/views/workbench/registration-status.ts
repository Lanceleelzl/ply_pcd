import type { RegistrationIteration } from '../../api/contracts';

export function cancelledRegistrationStatus(progress: RegistrationIteration | null): string {
  return progress
    ? '任务已终止。视口停留在未收敛的中间姿态，该姿态不是有效业务矩阵，可继续粗调后重新执行。'
    : '任务已终止，可调整参数或粗配准后重新执行。';
}

export const registrationStatus = {
  restored: '已恢复最近一次配准结果。',
  historyUnavailable: '历史结果暂时无法加载，可重新配准。',
};
