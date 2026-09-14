export interface InspectorToolState {
  clipping: boolean;
  originPlanes: boolean;
  query: boolean;
}

export function openOriginPlanes(state: InspectorToolState, closeQuery: () => void, refresh: () => void): void {
  state.originPlanes = true;
  state.clipping = false;
  closeQuery();
  refresh();
}

export function closeOriginPlanes(state: InspectorToolState, refresh: () => void): void {
  state.originPlanes = false;
  refresh();
}
