import type { Matrix4, ModelId, RegistrationResult, RegistrationSession } from '../api/contracts';
import { RegistrationJobController } from '../engine/modules/RegistrationJobController.ts';
import type { createRegistrationResultState } from '../stores/registration-result-state';
import type { createWorkbenchActivity } from '../stores/workbench-activity';
import type { IcpParameterValues } from '../views/workbench/icp-parameter-state';
import { buildRegistrationRequest } from '../views/workbench/registration-request.ts';
import { createRegistrationResultActions } from '../views/workbench/registration-result-actions.ts';
import type { createRegistrationRoleState } from '../views/workbench/registration-role-state';
import { cancelledRegistrationStatus } from '../views/workbench/registration-status.ts';
import { restoreWorkbenchHistory } from './workbench-history-restoration.ts';
import { createWorkbenchRegistrationActions } from './workbench-registration-actions.ts';

type Activity = ReturnType<typeof createWorkbenchActivity>;
type Results = ReturnType<typeof createRegistrationResultState>;
type Role = ReturnType<typeof createRegistrationRoleState>;

interface RegistrationDisplayPort {
  businessMatrices: Record<ModelId, Matrix4>;
  signature(): string;
  getMovingLocalToFixedLocal(): Matrix4;
  setMovingLocalToFixedLocal(matrix: Matrix4): void;
}

interface CoordinateQueryPort {
  invalidate(): void;
  setResult(result: RegistrationResult, jobId: string): void;
}

export interface WorkbenchRegistrationRuntimeOptions {
  sessionId: string;
  registrations: RegistrationSession['registrations'];
  signal: AbortSignal;
  activity: Activity;
  results: Results;
  role: Role;
  icp: IcpParameterValues;
  display: RegistrationDisplayPort;
  query(): CoordinateQueryPort | null;
  runningChanged(running: boolean): void;
  refreshRoles(reset: boolean): void;
  fitCamera(): void;
  initialSource?(): 'manual' | '4pcs' | '4pcs_adjusted';
}

export function createWorkbenchRegistrationRuntime(options: WorkbenchRegistrationRuntimeOptions) {
  const { activity, results, role, icp, display } = options;
  const showResult = (result: RegistrationResult, jobId: string) => {
    display.setMovingLocalToFixedLocal(result.moving_local_to_fixed_local);
    options.query()?.setResult(result, jobId);
    results.show(result, role.direction, display.signature());
  };
  const resultActions = createRegistrationResultActions({
    setMovingLocalToFixedLocal: matrix => display.setMovingLocalToFixedLocal(matrix),
    updateProgress: progress => results.updateProgress(progress),
    showResult,
    complete: (result, progressVisible) => results.complete(result, progressVisible),
  });
  const jobs = new RegistrationJobController({
    runningChanged: options.runningChanged,
    statusChanged: status => { results.state.status = status; },
    progressChanged: resultActions.progress,
    succeeded: (result, jobId) => resultActions.succeeded(result, jobId, activity.state.progress),
    cancelled: latestProgress => {
      if (latestProgress) display.setMovingLocalToFixedLocal(latestProgress.moving_local_to_fixed_local);
      results.state.status = cancelledRegistrationStatus(latestProgress);
    },
  }, options.signal);
  const actions = createWorkbenchRegistrationActions({
    sessionId: options.sessionId, signal: options.signal, activity: activity.state, jobs, results,
    invalidateQuery: () => options.query()?.invalidate(),
    setStatus: status => { results.state.status = status; },
    buildRequest: () => buildRegistrationRequest({
      initialMovingLocalToFixedLocal: display.getMovingLocalToFixedLocal(),
      outputDirection: role.direction,
      movingModel: role.moving,
      minRmsDecrease: icp.min_rms_decrease,
      samplingLimit: icp.sampling_limit,
      overlap: icp.overlap,
      randomSeed: icp.random_seed,
      initialSource: options.initialSource?.() ?? 'manual',
    }),
  });
  return {
    actions,
    restore: () => restoreWorkbenchHistory({
      registrations: options.registrations, signal: options.signal, role, icp,
      signature: () => display.signature(), running: () => activity.state.running,
      businessMatrices: display.businessMatrices, refreshRoles: options.refreshRoles, showResult,
      setStatus: status => { results.state.status = status; }, fitCamera: options.fitCamera,
    }),
    destroy: () => jobs.destroy(),
  };
}
