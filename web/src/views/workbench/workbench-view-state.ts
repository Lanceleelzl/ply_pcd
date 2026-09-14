export interface WorkbenchViewState {
  roleSummary: string;
  initialMatrix: string;
  help: string;
}

export function createWorkbenchViewState(): WorkbenchViewState {
  return { roleSummary: '', initialMatrix: '', help: '' };
}

export function setWorkbenchHelp(state: WorkbenchViewState, help: string): void {
  state.help = help;
}
