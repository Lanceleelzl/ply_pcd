import assert from 'node:assert/strict';
import test from 'node:test';
import { clippingStateSummary, clippingToolbarSummary, clippingToolbarTitle } from './clipping-toolbar-state.ts';

test('formats clipping toolbar mode and scope', () => {
  assert.equal(clippingToolbarSummary('off', 'both'), '剖切已关闭');
  assert.equal(clippingToolbarSummary('axis', 'a'), '坐标轴剖切：模型 A');
  assert.equal(clippingToolbarTitle('长方体剖切：A、B'), '长方体剖切：A、B；点击打开或关闭剖切面板');
  assert.equal(clippingStateSummary('independent', 'off', { a: 'axis', b: 'box' }), '独立剖切：A 坐标轴，B 长方体');
});
