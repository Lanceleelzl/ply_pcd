import assert from 'node:assert/strict';
import * as pc from 'playcanvas';
import test from 'node:test';
import { createWorkbenchFrameUpdater } from './workbench-frame-updater.ts';

test('runs frame updates in stable scene-to-view order', () => {
  const calls: string[] = [];
  const update = createWorkbenchFrameUpdater({
    invalidateResult: () => calls.push('result'), readPose: () => [new pc.Vec3(1, 2, 3), new pc.Vec3(4, 5, 6)], readScale: () => 2,
    updatePose: values => { calls.push(`pose:${values.length}:${values[6]}`); }, readMatrix: () => 'matrix', updateMatrix: value => calls.push(value),
    syncClipping: () => calls.push('clip'), updateClippingHandles: () => calls.push('handles'),
  });
  update();
  assert.deepEqual(calls, ['result', 'pose:7:2', 'matrix', 'clip', 'handles']);
});
