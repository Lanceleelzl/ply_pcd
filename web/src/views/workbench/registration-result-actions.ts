import type { RegistrationIteration, RegistrationResult } from '../../api/contracts';

export interface RegistrationResultActions {
  setMovingLocalToFixedLocal: (matrix: RegistrationResult['moving_local_to_fixed_local']) => void;
  updateProgress: (progress: RegistrationIteration) => void;
  showResult: (result: RegistrationResult, jobId: string) => void;
  complete: (result: RegistrationResult, progressVisible: boolean) => void;
}

export function createRegistrationResultActions(actions: RegistrationResultActions) {
  return {
    progress: (progress: RegistrationIteration) => {
      actions.setMovingLocalToFixedLocal(progress.moving_local_to_fixed_local);
      actions.updateProgress(progress);
    },
    succeeded: (result: RegistrationResult, jobId: string, progressVisible: boolean) => {
      actions.setMovingLocalToFixedLocal(result.moving_local_to_fixed_local);
      actions.showResult(result, jobId);
      actions.complete(result, progressVisible);
    },
  };
}
