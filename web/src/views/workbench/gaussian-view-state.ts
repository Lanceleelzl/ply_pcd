import { reactive } from 'vue';
import type { ModelId } from '../../api/contracts';

export interface GaussianViewState {
  models: Record<ModelId, { active: boolean; loading: boolean }>;
  message: string;
  error: boolean;
}

export function createGaussianViewState(): GaussianViewState {
  return reactive({
    models: { a: { active: false, loading: false }, b: { active: false, loading: false } },
    message: '', error: false,
  });
}
