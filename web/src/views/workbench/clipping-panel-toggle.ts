export interface ClippingPanelToggleState {
  clipping: boolean;
  originPlanes: boolean;
}

export function toggleClippingPanel(
  state: ClippingPanelToggleState,
  onOpened: () => void,
  onClosed: () => void,
): boolean {
  state.clipping = !state.clipping;
  if (state.clipping) {
    state.originPlanes = false;
    onOpened();
  } else {
    onClosed();
  }
  return state.clipping;
}
