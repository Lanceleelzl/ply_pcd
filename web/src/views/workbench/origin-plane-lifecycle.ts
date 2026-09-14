export interface OriginPlaneLifecycleState {
  originPlanes: boolean;
  clipping: boolean;
}

export function applyOriginPlaneVisibility(state: OriginPlaneLifecycleState, active: boolean, closeQuery: () => void, refreshTools: () => void, setToolbarActive: (active: boolean) => void): void {
  state.originPlanes = active;
  setToolbarActive(active);
  if (active) {
    state.clipping = false;
    closeQuery();
  }
  refreshTools();
}
