import { createApp, h, shallowReactive } from 'vue';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
import CoordinatePanel from './CoordinatePanel.vue';

export interface CoordinatePanelState {
  source: ModelId;
  points: Record<ModelId, XYZ> | null;
  original: boolean;
  clippingActive: boolean;
  jobId: string;
  message: string;
}
export function mountCoordinatePanel(panel: HTMLElement, handlers: {
  onAction: (action: string) => void;
  onSource: (model: ModelId) => void;
  onChange: (values: XYZ) => void;
  onInvalid: () => void;
}) {
  const state = shallowReactive<CoordinatePanelState>({ source: 'a', points: null, original: false, clippingActive: false, jobId: '', message: '' });
  const app = createApp({ render: () => h(CoordinatePanel, { state, ...handlers }) });
  app.mount(panel);
  return { state, destroy: () => app.unmount() };
}
