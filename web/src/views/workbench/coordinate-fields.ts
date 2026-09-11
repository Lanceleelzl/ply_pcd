import { h, shallowReactive } from 'vue';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
import CoordinatePanel from './CoordinatePanel.vue';
import type { InspectorState } from './inspector-state';

import type { CoordinatePanelState } from '../../engine/tools/coordinate-query-state';
import '../../coordinate-query.css';

export function createCoordinatePanel(root: HTMLElement, inspector: InspectorState, handlers: {
  onAction: (action: string) => void;
  onSource: (model: ModelId) => void;
  onChange: (values: XYZ) => void;
  onInvalid: () => void;
}) {
  const panel = root.querySelector<HTMLElement>('.coordinate-panel')!;
  const state = shallowReactive<CoordinatePanelState>({ source: 'a', points: null, original: false, clippingActive: false, jobId: '', message: '' });
  return {
    state,
    render: () => h(CoordinatePanel, { state, ...handlers }),
    setVisible(visible: boolean) {
      inspector.query = visible;
      if (visible) panel.parentElement!.scrollTop = 0;
    },
    copyText(text: string) { return navigator.clipboard.writeText(text); },
  };
}
