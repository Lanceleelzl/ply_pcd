import type { OutputDirection, RegistrationResult } from '../../api/contracts';

export interface ResultViewState {
  result: RegistrationResult | null;
  direction: OutputDirection;
  visible: boolean;
  status: string;
  progressVisible: boolean;
  progressCompleted: boolean;
  progressText: string;
}
