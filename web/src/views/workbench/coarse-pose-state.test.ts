import assert from 'node:assert/strict';
import * as pc from 'playcanvas';
import test from 'node:test';
import { poseValues, splitCoarsePose } from './coarse-pose-state.ts';

test('splits and reads coarse pose values in position-rotation order', () => {
  assert.deepEqual(splitCoarsePose([1, 2, 3, 4, 5, 6]), { position: [1, 2, 3], rotation: [4, 5, 6] });
  assert.deepEqual(poseValues(new pc.Vec3(1, 2, 3), new pc.Vec3(4, 5, 6)), [1, 2, 3, 4, 5, 6]);
});
