import assert from 'node:assert/strict';
import test from 'node:test';
import * as pc from 'playcanvas';
import { fitClipBox, worldBounds } from './clip-box-fitting.ts';

test('computes exact world bounds from rotated and non-uniformly scaled model corners', () => {
  const a = {
    min: new pc.Vec3(-1, -2, -3),
    max: new pc.Vec3(1, 2, 3),
    transform: new pc.Mat4().setTRS(
      new pc.Vec3(10, 20, 30),
      new pc.Quat().setFromEulerAngles(0, 0, 90),
      new pc.Vec3(2, 3, 4),
    ),
  };
  const b = {
    min: new pc.Vec3(-2, -1, -1),
    max: new pc.Vec3(2, 1, 1),
    transform: new pc.Mat4().setTranslate(-20, 5, 7),
  };
  const aMin = a.min.clone();
  const aMax = a.max.clone();

  const onlyA = worldBounds(['a'], { a, b });
  assert.deepEqual(onlyA.min.toArray().map(Math.round), [4, 18, 18]);
  assert.deepEqual(onlyA.max.toArray().map(Math.round), [16, 22, 42]);
  const both = worldBounds(['a', 'b'], { a, b });
  assert.deepEqual(both.min.toArray().map(Math.round), [-22, 4, 6]);
  assert.deepEqual(both.max.toArray().map(Math.round), [16, 22, 42]);
  assert.deepEqual(a.min.toArray(), aMin.toArray());
  assert.deepEqual(a.max.toArray(), aMax.toArray());
});

test('fits a box to world bounds with non-zero scale', () => {
  const box = new pc.Entity();
  fitClipBox(box, { min: new pc.Vec3(1, 2, 3), max: new pc.Vec3(1, 4, 5) });
  assert.deepEqual(box.getPosition().toArray(), [1, 3, 4]);
  assert.deepEqual(box.getLocalScale().toArray(), [0.001, 2, 2]);
});
