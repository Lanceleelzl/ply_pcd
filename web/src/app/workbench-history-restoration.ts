import type { Matrix4, ModelId, RegistrationRequest, RegistrationResult, RegistrationSession } from '../api/contracts';
import { restoreRegistrationHistory } from '../stores/registration-history.ts';
import type { IcpParameterValues } from '../views/workbench/icp-parameter-state';
import { registrationStatus } from '../views/workbench/registration-status.ts';

type HistoryRegistration = NonNullable<RegistrationSession['registrations']>[number];

interface HistoryRoleState {
  moving: RegistrationRequest['moving_model'];
  direction: HistoryRegistration['output_direction'];
}

export interface WorkbenchHistoryOptions {
  registrations: RegistrationSession['registrations'];
  signal: AbortSignal;
  role: HistoryRoleState;
  icp: IcpParameterValues;
  businessMatrices: Record<ModelId, Matrix4>;
  signature(): string;
  running(): boolean;
  refreshRoles(reset: boolean): void;
  showResult(result: RegistrationResult, jobId: string): void;
  setStatus(status: string): void;
  fitCamera(): void;
}

export function applyRestoredRegistration(
  result: RegistrationResult,
  registration: HistoryRegistration,
  options: Pick<WorkbenchHistoryOptions, 'role' | 'icp' | 'refreshRoles' | 'showResult' | 'setStatus' | 'fitCamera'>,
): void {
  options.role.moving = result.moving_model;
  options.role.direction = registration.output_direction;
  options.refreshRoles(true);
  (Object.keys(options.icp) as Array<keyof IcpParameterValues>).forEach(name => {
    if (registration.parameters[name] !== undefined) options.icp[name] = String(registration.parameters[name]);
  });
  options.showResult(result, registration.job_id);
  options.setStatus(registrationStatus.restored);
  options.fitCamera();
}

export async function restoreWorkbenchHistory(options: WorkbenchHistoryOptions): Promise<void> {
  await restoreRegistrationHistory(options.registrations, options.signal, {
    signature: options.signature,
    running: options.running,
    businessMatrices: options.businessMatrices,
    apply: (result, registration) => applyRestoredRegistration(result, registration, options),
    unavailable: () => options.setStatus(registrationStatus.historyUnavailable),
  });
}
