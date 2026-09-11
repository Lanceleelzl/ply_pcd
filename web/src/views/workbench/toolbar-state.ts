import type { ModelId } from '../../api/contracts';

export interface ToolbarState {
  locked: boolean;
  visible: Record<ModelId, boolean>;
  axes: Record<ModelId, boolean>;
  originPlanesActive: boolean;
  clippingActive: boolean;
  clippingTitle: string;
  queryActive: boolean;
  queryAvailable: boolean;
  queryTitle: string;
}

export type ToolbarCommand =
  | { type: 'reset' | 'fit' | 'clipping' | 'origin-planes' | 'query' }
  | { type: 'visibility' | 'origin-axes' | 'gaussian'; model: ModelId };
