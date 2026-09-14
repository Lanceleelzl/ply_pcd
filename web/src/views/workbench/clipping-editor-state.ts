import type { ModelId } from '../../api/contracts';
export { editedClippingMode } from '../../engine/modules/ClippingStateController.ts';

export function editedClippingModel(controlMode: 'joint' | 'independent', editor: ModelId): 'joint' | ModelId {
  return controlMode === 'joint' ? 'joint' : editor;
}
