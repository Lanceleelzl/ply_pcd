import assert from 'node:assert/strict';
import test from 'node:test';
import * as pc from 'playcanvas';
import { combinedPreviewBounds } from './workbench-clipping-runtime.ts';

test('combines both preview bounds without mutating either cloud', () => {
  const a = { min: new pc.Vec3(-5, 2, 7), max: new pc.Vec3(4, 8, 10) };
  const b = { min: new pc.Vec3(-2, -3, 9), max: new pc.Vec3(12, 6, 15) };
  const bounds = combinedPreviewBounds({ a, b });
  assert.deepEqual(bounds.min.toArray(), [-5, -3, 7]);
  assert.deepEqual(bounds.max.toArray(), [12, 8, 15]);
  bounds.min.x = 99;
  assert.equal(a.min.x, -5);
});
