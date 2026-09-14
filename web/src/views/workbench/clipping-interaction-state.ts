import type { ClippingMode } from '../../engine/modules/ClippingStateController';

export function isClippingInteractionActive(panelVisible: boolean, mode: ClippingMode): boolean {
  return panelVisible && mode !== 'off';
}

export function clippingHandleMode(queryActive: boolean, interactionActive: boolean, mode: ClippingMode): ClippingMode | 'off' {
  return queryActive && !interactionActive ? 'off' : mode;
}
