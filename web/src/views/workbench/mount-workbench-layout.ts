import { h } from 'vue';
import type { RegistrationSession } from '../../api/contracts';
import type { GaussianViewState } from './gaussian-view-state';
import type { ToolbarCommand, ToolbarState } from './toolbar-state';
import type { ResultViewState } from './result-view-state';
import type { InspectorState } from './inspector-state';
import WorkbenchLayout from './WorkbenchLayout.vue';
import type { WorkbenchPanels } from './workbench-panels';

export interface WorkbenchLayoutOptions {
  view: { roleSummary: string; initialMatrix: string; help: string };
  onNewTask: () => void;
  session: RegistrationSession;
  gaussian: GaussianViewState;
  toolbar: ToolbarState;
  result: ResultViewState;
  inspector: InspectorState;
  panels: WorkbenchPanels;
  onToolbar: (command: ToolbarCommand) => void;
}

export function WorkbenchContent({ options }: { options: WorkbenchLayoutOptions }) {
  const { panels, ...props } = options;
  return h(WorkbenchLayout, props, { ...panels });
}
