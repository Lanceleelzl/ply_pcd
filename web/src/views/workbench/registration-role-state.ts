import type { ModelId, RegistrationRequest, RegistrationSession } from '../../api/contracts';

export interface RegistrationRoleState {
  moving: RegistrationRequest['moving_model'];
  direction: RegistrationRequest['output_direction'];
}

export function createRegistrationRoleState(session: RegistrationSession): RegistrationRoleState {
  return { moving: session.moving_model, direction: session.output_direction };
}

export function effectiveMovingModel(value: RegistrationRequest['moving_model'], recommended: ModelId): ModelId {
  return value === 'auto' ? recommended : value;
}

export function fixedModel(moving: ModelId): ModelId {
  return moving === 'a' ? 'b' : 'a';
}

export function roleSummary(moving: ModelId): string {
  return `移动 ${moving.toUpperCase()}（黄色）　固定 ${fixedModel(moving).toUpperCase()}（灰色）`;
}
