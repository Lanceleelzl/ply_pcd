import { createApp, h, shallowReactive } from 'vue';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
import CoordinateFields from './CoordinateFields.vue';

export function mountCoordinateFields(panel: HTMLElement, change: (values: XYZ) => void, invalid: () => void) {
  const state = shallowReactive<{ source: ModelId; points: Record<ModelId, XYZ> | null }>({ source: 'a', points: null });
  const empty: XYZ = [0, 0, 0];
  const apps = (['a', 'b'] as const).map(model => {
    const app = createApp({ render: () => h(CoordinateFields, {
      model, source: state.source, values: state.points?.[model] ?? empty, onChange: change, onInvalid: invalid,
    }) });
    app.mount(panel.querySelector(`[data-coordinate-fields="${model}"]`)!);
    return app;
  });
  return { state, destroy: () => apps.forEach(app => app.unmount()) };
}
