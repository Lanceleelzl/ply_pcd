import { h, reactive } from 'vue';
import type { ModelId } from '../../api/contracts';
import { createOriginPlaneState, type OriginPlane } from '../../origin-plane-state';
import OriginPlaneForm from './OriginPlaneForm.vue';
import type { InspectorState } from './inspector-state';

export function createOriginPlanePanel(root: HTMLElement, inspector: InspectorState, activeChanged: (active: boolean) => void) {
  const state = reactive(createOriginPlaneState());
  const panel = root.querySelector<HTMLElement>('.origin-planes-panel')!;
  const refresh = () => {
    const active = Object.values(state).some(model => Object.values(model).some(plane => plane.visible || plane.side !== 0));
    activeChanged(active);
  };
  const togglePanel = () => {
    inspector.originPlanes = !inspector.originPlanes;
    if (inspector.originPlanes) panel.parentElement!.scrollTop = 0;
  };
  const render = () => h(OriginPlaneForm, {
    state,
    onVisible: (model: ModelId, plane: OriginPlane, value: boolean) => { state[model][plane].visible = value; refresh(); },
    onSide: (model: ModelId, plane: OriginPlane, value: number) => { state[model][plane].side = value; refresh(); },
    onClose: () => { inspector.originPlanes = false; },
    onClear: () => { Object.assign(state, createOriginPlaneState()); refresh(); },
  });
  refresh();
  return {
    state,
    render,
    toggle: togglePanel,
  };
}
