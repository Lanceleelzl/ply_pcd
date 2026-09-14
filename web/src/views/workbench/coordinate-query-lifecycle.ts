export interface CoordinateQueryLifecycleState {
  queryActive: boolean;
}

export function applyCoordinateQueryLock(state: CoordinateQueryLifecycleState, active: boolean, closeConflictingTools: () => void, restoreTools: () => void, refreshTools: () => void): void {
  state.queryActive = active;
  if (active) {
    closeConflictingTools();
  } else {
    restoreTools();
  }
  refreshTools();
}
