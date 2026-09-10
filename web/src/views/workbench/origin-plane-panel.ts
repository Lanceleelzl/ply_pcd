import { createApp, h, reactive } from 'vue';
import type { ModelId } from '../../api/contracts';
import { createOriginPlaneState, type OriginPlane } from '../../origin-plane-state';
import OriginPlaneForm from './OriginPlaneForm.vue';

export function mountOriginPlanePanel(root: HTMLElement) {
  const state = reactive(createOriginPlaneState());
  const toggle = root.querySelector<HTMLButtonElement>('#origin-planes-toggle')!;
  const panel = root.querySelector<HTMLElement>('.origin-planes-panel')!;
  const refresh = () => {
    const active = Object.values(state).some(model => Object.values(model).some(plane => plane.visible || plane.side !== 0));
    toggle.classList.toggle('active', active);
    toggle.setAttribute('aria-pressed', String(active));
  };
  const togglePanel = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.parentElement!.scrollTop = 0;
  };
  const form = createApp({ render: () => h(OriginPlaneForm, {
    state,
    onVisible: (model: ModelId, plane: OriginPlane, value: boolean) => { state[model][plane].visible = value; refresh(); },
    onSide: (model: ModelId, plane: OriginPlane, value: number) => { state[model][plane].side = value; refresh(); },
    onClose: () => { panel.hidden = true; },
    onClear: () => { Object.assign(state, createOriginPlaneState()); refresh(); },
  }) });
  form.mount(panel);
  toggle.addEventListener('click', togglePanel);
  refresh();
  return {
    state,
    destroy() {
      toggle.removeEventListener('click', togglePanel);
      form.unmount();
    },
  };
}
