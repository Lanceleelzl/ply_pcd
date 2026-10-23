import assert from 'node:assert/strict';
import * as pc from 'playcanvas';
import test from 'node:test';
import { poseValues, splitCoarsePose } from './coarse-pose-state.ts';

test('splits and reads coarse pose with default and explicit uniform scale', () => {
  assert.deepEqual(splitCoarsePose([1, 2, 3, 4, 5, 6]), { position: [1, 2, 3], rotation: [4, 5, 6], scale: 1 });
  assert.deepEqual(splitCoarsePose([1, 2, 3, 4, 5, 6, 2]), { position: [1, 2, 3], rotation: [4, 5, 6], scale: 2 });
  assert.deepEqual(poseValues(new pc.Vec3(1, 2, 3), new pc.Vec3(4, 5, 6), 2), [1, 2, 3, 4, 5, 6, 2]);
});
