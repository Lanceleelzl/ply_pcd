import type { RegistrationJobController } from '../../engine/modules/RegistrationJobController';
import type { createRegistrationResultState } from '../../stores/registration-result-state';
import type { createWorkbenchActivity } from '../../stores/workbench-activity';

type RegistrationResultState = ReturnType<typeof createRegistrationResultState>;
type WorkbenchActivityState = ReturnType<typeof createWorkbenchActivity>['state'];

export function setRegistrationProgressVisible(
  visible: boolean,
  activity: WorkbenchActivityState,
  jobs: RegistrationJobController,
  results: RegistrationResultState,
): void {
  activity.progress = visible;
  jobs.setProgressVisible(visible);
  results.setProgressVisible(visible, activity.running);
}

export async function cancelRegistration(
  activity: WorkbenchActivityState,
  jobs: RegistrationJobController,
  onError: (error: unknown) => void,
): Promise<void> {
  if (!activity.running || activity.cancelling) return;
  activity.cancelling = true;
  try {
    await jobs.cancel();
  } catch (error) {
    onError(error);
    activity.cancelling = false;
  }
}
