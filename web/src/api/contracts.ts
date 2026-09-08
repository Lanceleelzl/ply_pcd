import type { TransformParameters } from '../coordinate-math';

export type ModelId = 'a' | 'b';
export type OutputDirection = 'a_to_b' | 'b_to_a';
export type Matrix4 = number[][];

export interface RegistrationSession {
  status: string;
  error?: string;
  output_direction: OutputDirection;
  moving_model: 'auto' | ModelId;
  model_a_preview_url?: string;
  model_b_preview_url?: string;
  gaussian_a_url?: string;
  gaussian_b_url?: string;
  inputs?: { model_a_bytes?: number; model_b_bytes?: number };
  business_transforms?: Record<ModelId, TransformParameters>;
  registrations?: Array<{
    job_id: string;
    status: string;
    result_url?: string;
    output_direction: OutputDirection;
    parameters: Record<string, number>;
  }>;
  metadata?: {
    recommended_moving_model: ModelId;
    models: Record<ModelId, {
      format: string;
      source_point_count: number;
      preview_point_count: number;
      origin: number[];
    }>;
  };
}

export interface RegistrationRequest {
  initial_moving_local_to_fixed_local: Matrix4;
  output_direction: OutputDirection;
  moving_model: 'auto' | ModelId;
  min_rms_decrease: number;
  sampling_limit: number;
  overlap: number;
  random_seed: number;
  show_registration_progress: boolean;
  coordinate_space: 'business';
}

export interface RegistrationResult {
  recommended_matrix: { name: string; formula: string; value: Matrix4 };
  moving_model: ModelId;
  moving_local_to_fixed_local: Matrix4;
  a_to_b: Matrix4;
  b_to_a: Matrix4;
  file_a_to_b?: Matrix4;
  file_b_to_a?: Matrix4;
  business_transforms?: Record<ModelId, { matrix: Matrix4 }>;
  coordinate_space?: 'file' | 'business';
  metrics: { final_rms: number; final_point_count: number; elapsed_seconds: number };
}

export interface RegistrationIteration {
  type: 'iteration';
  iteration: number;
  rms: number;
  point_count: number;
  elapsed_seconds: number;
  moving_local_to_fixed_local: Matrix4;
}

export interface HistoryItem {
  session_id: string;
  completed_at_unix?: number;
  source_expires_at_unix?: number;
  source_available: boolean;
  restartable: boolean;
  output_direction?: OutputDirection;
  models?: Record<ModelId, { filename?: string; format?: string; bytes?: number }>;
  recommended_matrix?: { name?: string; value?: number[][] };
  metrics?: { final_rms?: number; final_point_count?: number; elapsed_seconds?: number };
}

export interface CreateSessionInput {
  modelA: File;
  modelB: File;
  modelATransform: TransformParameters;
  modelBTransform: TransformParameters;
  outputDirection: OutputDirection;
  movingModel: 'auto' | ModelId;
  workspaceId: string;
}
