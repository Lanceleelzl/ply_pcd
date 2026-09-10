import { createApp } from 'vue';
import type { RegistrationSession } from '../../api/contracts';
import WorkbenchLayout from './WorkbenchLayout.vue';

export function mountWorkbenchLayout(root: HTMLElement, session: RegistrationSession): () => void {
  const app = createApp(WorkbenchLayout, { session });
  app.mount(root);
  return () => app.unmount();
}
