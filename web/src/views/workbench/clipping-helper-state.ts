import type { ModelId } from '../../api/contracts';
import type { ClippingMode } from '../../engine/modules/ClippingStateController';

export function isJointBoxHelperVisible(controlMode: 'joint' | 'independent', jointMode: ClippingMode, jointHelperVisible: boolean): boolean {
  return controlMode === 'joint' && jointMode === 'box' && jointHelperVisible;
}

export function isIndependentBoxHelperVisible(controlMode: 'joint' | 'independent', model: ModelId, modes: Record<ModelId, ClippingMode>, helpers: Record<ModelId, boolean>): boolean {
  return controlMode === 'independent' && modes[model] === 'box' && helpers[model];
}
