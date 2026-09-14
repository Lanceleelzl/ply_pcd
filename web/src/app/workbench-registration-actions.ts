import type { RegistrationRequest } from '../api/contracts';
import { cancelRegistration, setRegistrationProgressVisible } from '../views/workbench/registration-actions.ts';
import type { RegistrationJobController } from '../engine/modules/RegistrationJobController';
import type { createRegistrationResultState } from '../stores/registration-result-state';
import type { createWorkbenchActivity } from '../stores/workbench-activity';

type RegistrationActivity = ReturnType<typeof createWorkbenchActivity>['state'];
type RegistrationResults = ReturnType<typeof createRegistrationResultState>;

export interface WorkbenchRegistrationActionOptions {
  sessionId: string;
  signal: AbortSignal;
  activity: RegistrationActivity;
  jobs: RegistrationJobController;
  results: RegistrationResults;
  invalidateQuery(): void;
  buildRequest(): RegistrationRequest;
  setStatus(status: string): void;
}

export function createWorkbenchRegistrationActions(options: WorkbenchRegistrationActionOptions) {
  const setProgress = (visible: boolean) => {
    setRegistrationProgressVisible(visible, options.activity, options.jobs, options.results);
  };

  const cancel = async () => {
    await cancelRegistration(options.activity, options.jobs, error => {
      if (!options.signal.aborted) options.setStatus(`终止失败：${String(error)}`);
    });
  };

  const run = async () => {
    if (options.activity.editingLocked) return;
    options.invalidateQuery();
    options.results.begin(options.activity.progress);
    options.jobs.setProgressVisible(options.activity.progress);
    try {
      await options.jobs.run(options.sessionId, options.buildRequest());
    } catch (error) {
      if (!options.signal.aborted) options.setStatus(`失败：${String(error)}`);
    }
  };

  return { run, cancel, setProgress };
}
