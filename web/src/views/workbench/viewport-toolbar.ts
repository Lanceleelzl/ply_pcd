import { reactive } from 'vue';
import type { ToolbarState } from './toolbar-state';

export function createViewportToolbar() {
  const state = reactive<ToolbarState>({
    locked: false, visible: { a: true, b: true }, axes: { a: false, b: false },
    originPlanesActive: false, clippingActive: false, clippingTitle: '',
    queryActive: false, queryAvailable: false, queryTitle: '完成 ICP 后可查询坐标对',
  });
  return {
    state,
    setAvailable(available: boolean, title: string) { state.queryAvailable = available; state.queryTitle = title; },
    setActive(active: boolean) { state.queryActive = active; },
  };
}
