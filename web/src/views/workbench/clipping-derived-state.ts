import type { ModelId } from '../../api/contracts';
import type { ClippingMode } from '../../engine/modules/ClippingStateController';
import { isIndependentBoxHelperVisible, isJointBoxHelperVisible } from './clipping-helper-state.ts';
import { isClippingInteractionActive } from './clipping-interaction-state.ts';

export interface ClippingDerivedState {
  controlMode: 'joint' | 'independent';
  editor: ModelId;
  jointMode: ClippingMode;
  jointHelperVisible: boolean;
  independentModes: Record<ModelId, ClippingMode>;
  independentHelpers: Record<ModelId, boolean>;
  panelVisible: boolean;
}

export function updateClippingDerivedState(
  state: ClippingDerivedState,
  setJointHelper: (visible: boolean) => void,
  setIndependentHelper: (model: ModelId, visible: boolean) => void,
  setInteraction: (active: boolean) => void,
): void {
  setJointHelper(isJointBoxHelperVisible(state.controlMode, state.jointMode, state.jointHelperVisible));
  (['a', 'b'] as ModelId[]).forEach(model => setIndependentHelper(model, isIndependentBoxHelperVisible(state.controlMode, model, state.independentModes, state.independentHelpers)));
  const editedMode = state.controlMode === 'joint' ? state.jointMode : state.independentModes[state.editor];
  setInteraction(isClippingInteractionActive(state.panelVisible, editedMode));
}
