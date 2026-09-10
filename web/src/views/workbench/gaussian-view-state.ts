import type { ModelId } from '../../api/contracts';

export interface GaussianViewState {
  models: Record<ModelId, { active: boolean; loading: boolean }>;
  message: string;
  error: boolean;
}
