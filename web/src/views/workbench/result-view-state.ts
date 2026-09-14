import type { RegistrationResult } from '../../api/contracts';

export interface ResultViewState {
  result: RegistrationResult | null;
  direction: string;
  visible: boolean;
  status: string;
  progressVisible: boolean;
  progressCompleted: boolean;
  progressText: string;
}
