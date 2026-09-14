import type { Matrix4, ModelId, RegistrationRequest } from '../../api/contracts';

export interface RegistrationRequestInputs {
  initialMovingLocalToFixedLocal: Matrix4;
  outputDirection: RegistrationRequest['output_direction'];
  movingModel: RegistrationRequest['moving_model'];
  minRmsDecrease: string;
  samplingLimit: string;
  overlap: string;
  randomSeed: string;
  initialSource?: RegistrationRequest['initial_source'];
}

export function buildRegistrationRequest(input: RegistrationRequestInputs): RegistrationRequest {
  return {
    initial_moving_local_to_fixed_local: input.initialMovingLocalToFixedLocal,
    output_direction: input.outputDirection,
    moving_model: input.movingModel,
    min_rms_decrease: Number(input.minRmsDecrease),
    sampling_limit: Number(input.samplingLimit),
    overlap: Number(input.overlap),
    random_seed: Number(input.randomSeed),
    show_registration_progress: true,
    coordinate_space: 'business',
    initial_source: input.initialSource ?? 'manual',
  };
}

export function resolveMovingModel(value: RegistrationRequest['moving_model'], recommended: ModelId): ModelId {
  return value === 'auto' ? recommended : value;
}
