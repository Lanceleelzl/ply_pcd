import { createApp } from 'vue';
import type { RegistrationSession } from '../../api/contracts';
import type { GaussianViewState } from './gaussian-view-state';
import type { ToolbarCommand, ToolbarState } from './toolbar-state';
import WorkbenchLayout from './WorkbenchLayout.vue';

export function mountWorkbenchLayout(root: HTMLElement, options: {
  session: RegistrationSession;
  gaussian: GaussianViewState;
  toolbar: ToolbarState;
  onToolbar: (command: ToolbarCommand) => void;
}): () => void {
  const app = createApp(WorkbenchLayout, options);
  app.mount(root);
  return () => app.unmount();
}
