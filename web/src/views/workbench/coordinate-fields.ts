import { createApp, h, shallowReactive } from 'vue';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
import CoordinatePanel from './CoordinatePanel.vue';

import type { CoordinatePanelState } from '../../engine/tools/coordinate-query-state';
import '../../coordinate-query.css';

export function mountCoordinatePanel(root: HTMLElement, handlers: {
  onAction: (action: string) => void;
  onSource: (model: ModelId) => void;
  onChange: (values: XYZ) => void;
  onInvalid: () => void;
}) {
  const panel = document.createElement('section');
  panel.className = 'coordinate-panel';
  panel.hidden = true;
  root.querySelector('.viewport')!.append(panel);
  const state = shallowReactive<CoordinatePanelState>({ source: 'a', points: null, original: false, clippingActive: false, jobId: '', message: '' });
  const app = createApp({ render: () => h(CoordinatePanel, { state, ...handlers }) });
  app.mount(panel);
  return {
    state,
    setVisible(visible: boolean) { panel.hidden = !visible; },
    destroy() { app.unmount(); panel.remove(); },
  };
}
