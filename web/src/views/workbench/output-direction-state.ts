import type { RegistrationRequest } from '../../api/contracts';

export interface OutputDirectionState {
  direction: RegistrationRequest['output_direction'];
}

export function setOutputDirection(
  state: OutputDirectionState,
  direction: RegistrationRequest['output_direction'],
  invalidateResult: () => void,
  invalidateQuery: () => void,
): void {
  if (state.direction === direction) return;
  state.direction = direction;
  invalidateResult();
  invalidateQuery();
}
