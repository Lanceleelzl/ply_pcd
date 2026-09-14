import type { ClippingMode } from '../../engine/modules/ClippingStateController';
import { clippingStateSummary, clippingToolbarTitle } from './clipping-toolbar-state.ts';

export function clippingPresentation(controlMode: 'joint' | 'independent', jointMode: ClippingMode, independentModes: { a: ClippingMode; b: ClippingMode }, editedMode: ClippingMode) {
  const summary = clippingStateSummary(controlMode, jointMode, independentModes);
  return {
    active: editedMode !== 'off',
    title: clippingToolbarTitle(summary),
    help: editedMode === 'box'
      ? '左键空白：旋转　中键：平移　滚轮：缩放　左键手柄：调整剖切长方体'
      : '左键空白：旋转　中键：平移　滚轮：缩放　左键平移轴／面：移动模型　左键旋转圆环：旋转模型',
  };
}
