import assert from 'node:assert/strict';
import test from 'node:test';
import * as pc from 'playcanvas';
import { createClippingWorkbenchState } from './clipping-workbench-state.ts';

test('keeps joint and model clipping ranges independent and resets cleared targets', () => {
  const clipping = createClippingWorkbenchState({ min: new pc.Vec3(-2, -3, -4), max: new pc.Vec3(5, 6, 7) });
  clipping.setBoundary('a', 'x', 'min', 1.25);
  clipping.setMode('a', 'axis');
  clipping.setControl('independent');
  clipping.setEditor('a');
  assert.equal(clipping.activeTarget(), 'a');
  assert.equal(clipping.axisState('a').min.x, 1.25);
  assert.equal(clipping.axisState('joint').min.x, -2);
  clipping.clear('a');
  assert.equal(clipping.state.independentModes.a, 'off');
  assert.equal(clipping.ranges.a.x.min, -2);
  assert.equal(clipping.ranges.a.x.minEnabled, false);
});
