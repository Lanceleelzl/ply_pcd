import type { ModelId } from '../../api/contracts';

export type WorkbenchToolId = 'idle' | 'model-transform' | 'clipping' | 'coordinate-query';

export interface WorkbenchToolRoutingState {
  clippingInteractionActive: boolean;
  queryActive: boolean;
  running: boolean;
  movingVisible: boolean;
}

export function resolveWorkbenchTool(state: WorkbenchToolRoutingState): WorkbenchToolId {
  if (state.clippingInteractionActive) return 'clipping';
  if (state.queryActive) return 'coordinate-query';
  if (!state.running && state.movingVisible) return 'model-transform';
  return 'idle';
}

export function isMovingModelVisible(visible: Record<ModelId, boolean>, moving: ModelId): boolean {
  return visible[moving];
}
