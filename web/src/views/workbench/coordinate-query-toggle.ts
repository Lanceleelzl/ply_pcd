export interface CoordinateQueryToggleState {
  query: boolean;
  clipping: boolean;
  originPlanes: boolean;
}

export function toggleCoordinateQuery(
  state: CoordinateQueryToggleState,
  onOpened: () => void,
  onClosed: () => void,
): boolean {
  state.query = !state.query;
  if (state.query) {
    state.clipping = false;
    state.originPlanes = false;
    onOpened();
  } else {
    onClosed();
  }
  return state.query;
}
