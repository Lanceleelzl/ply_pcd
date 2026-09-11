import { createApp, h } from 'vue';
import type { RegistrationSession } from '../../api/contracts';
import type { GaussianViewState } from './gaussian-view-state';
import type { ToolbarCommand, ToolbarState } from './toolbar-state';
import type { ResultViewState } from './result-view-state';
import type { InspectorState } from './inspector-state';
import WorkbenchLayout from './WorkbenchLayout.vue';
import type { WorkbenchPanels } from './workbench-panels';

export function mountWorkbenchLayout(root: HTMLElement, options: {
  session: RegistrationSession;
  gaussian: GaussianViewState;
  toolbar: ToolbarState;
  result: ResultViewState;
  inspector: InspectorState;
  panels: WorkbenchPanels;
  onToolbar: (command: ToolbarCommand) => void;
}): () => void {
  const { panels, ...props } = options;
  const app = createApp({ render: () => h(WorkbenchLayout, props, { ...panels }) });
  app.mount(root);
  return () => app.unmount();
}
