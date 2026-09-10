import { createApp } from 'vue';
import type { ModelId, RegistrationSession } from '../../api/contracts';
import type { GaussianViewState } from './gaussian-view-state';
import WorkbenchLayout from './WorkbenchLayout.vue';

export function mountWorkbenchLayout(root: HTMLElement, session: RegistrationSession, gaussian: GaussianViewState, onGaussian: (model: ModelId) => void): () => void {
  const app = createApp(WorkbenchLayout, { session, gaussian, onGaussian });
  app.mount(root);
  return () => app.unmount();
}
