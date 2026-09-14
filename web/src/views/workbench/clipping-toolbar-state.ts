export type ClippingToolbarMode = 'off' | 'axis' | 'box';
export type ClippingToolbarScope = 'both' | 'a' | 'b';

export { clippingStateSummary } from '../../engine/modules/ClippingStateController.ts';

export function clippingToolbarSummary(mode: ClippingToolbarMode, scope: ClippingToolbarScope): string {
  if (mode === 'off') return '剖切已关闭';
  const modeText = mode === 'axis' ? '坐标轴剖切' : '长方体剖切';
  const scopeText = scope === 'both' ? 'A、B' : `模型 ${scope.toUpperCase()}`;
  return `${modeText}：${scopeText}`;
}

export function clippingToolbarTitle(summary: string): string {
  return `${summary}；点击打开或关闭剖切面板`;
}
