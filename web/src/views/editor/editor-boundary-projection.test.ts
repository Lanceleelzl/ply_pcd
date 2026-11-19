import assert from 'node:assert/strict';
import test from 'node:test';
import { clipSegmentToNearPlane, projectedSegmentPoint, projectVisiblePoint } from './editor-boundary-projection.ts';

test('volume handles hide before the near plane and reject invalid projections', () => {
  const point: [number, number, number] = [1, 2, 3];
  const project = () => ({ x: 20, y: 30 });
  assert.equal(projectVisiblePoint(point, -.5, .1, project), null);
  assert.equal(projectVisiblePoint(point, .099, .1, project), null);
  assert.equal(projectVisiblePoint(point, NaN, .1, project), null);
  assert.deepEqual(projectVisiblePoint(point, .1, .1, project), { x: 20, y: 30 });
  assert.equal(projectVisiblePoint(point, 1, .1, () => ({ x: Infinity, y: 30 })), null);
});

test('an edge crossing the camera plane remains hittable on its visible extension', () => {
  const clipped = clipSegmentToNearPlane([0, -2, 0], [1, 0, 0], -1, 1, 0.1);
  assert.ok(clipped);
  assert.ok(Math.abs(clipped[0][0] - 0.55) < 1e-12);
  const result = projectedSegmentPoint([clipped[0][0], clipped[0][1]], [clipped[1][0], clipped[1][1]],
    [1.5, -1], ([x, y]) => [x / (y + 1), y / (y + 1)], 0.1);
  assert.ok(result);
  assert.ok(Math.hypot(result.point[0] - .75, result.point[1] + .5) < .001);
});

test('near-plane clipping preserves visible endpoints and works in both directions', () => {
  assert.deepEqual(clipSegmentToNearPlane([0, 0, 0], [1, 0, 0], 1, 2, .1), [[0, 0, 0], [1, 0, 0]]);
  assert.deepEqual(clipSegmentToNearPlane([1, 0, 0], [0, -2, 0], 1, -1, .1), [[1, 0, 0], [.55, -.9, 0]]);
  assert.deepEqual(clipSegmentToNearPlane([0, 0, 0], [1, 0, 0], .1, 2, .1), [[0, 0, 0], [1, 0, 0]]);
  assert.equal(clipSegmentToNearPlane([0, 0, 0], [1, 0, 0], -1, -.5, .1), null);
  assert.equal(clipSegmentToNearPlane([0, 0, 0], [1, 0, 0], NaN, 1, .1), null);
});

test('a strongly magnified edge stays hittable and the inserted point matches the cursor', () => {
  const project = ([x, y]: [number, number]): [number, number] => [x * 100000, y * 100000];
  const result = projectedSegmentPoint([0, 0], [1, 0], [50000, 3], project, 8);
  assert.ok(result);
  assert.ok(Math.abs(result.screen[0] - 50000) < 0.01);
  assert.ok(Math.abs(result.distance - 3) < 0.01);
  assert.ok(Math.abs(result.point[0] - 0.5) < 1e-7);
});

test('an oblique perspective edge uses the projected nearest point instead of the world midpoint', () => {
  const project = ([x, y]: [number, number]): [number, number] => [1000 * x / (y + 0.001), 0];
  const result = projectedSegmentPoint([0, 0], [1, 1], [500, 2], project, 8);
  assert.ok(result);
  assert.ok(Math.abs(result.screen[0] - 500) < 0.01);
  assert.ok(Math.abs(result.point[0] - 0.001) < 1e-7);
});

test('reversing the edge preserves the same screen and world point', () => {
  const project = ([x, y]: [number, number]): [number, number] => [x * 100000, y * 100000];
  for (const [a, b] of [[[0, 1], [0, -1]], [[0, -1], [0, 1]]] as [number, number][][]) {
    const result = projectedSegmentPoint(a, b, [2, 25000], project, 8);
    assert.ok(result);
    assert.ok(Math.abs(result.point[1] - 0.25) < 1e-7);
    assert.ok(Math.abs(result.screen[1] - 25000) < 0.01);
  }
});

test('near an endpoint the nearest point remains on the segment', () => {
  const result = projectedSegmentPoint([0, 0], [1, 0], [103, 0], ([x, y]) => [100 * x, y], 8);
  assert.ok(result);
  assert.ok(Math.abs(result.point[0] - 1) < 0.0001);
  assert.ok(result.point[0] <= 1);
});

test('collapsed screen edges and cursors outside the hit radius are ignored', () => {
  assert.equal(projectedSegmentPoint([0, 0], [1, 0], [0, 0], () => [0, 0], 8), null);
  assert.equal(projectedSegmentPoint([0, 0], [1, 0], [0, 9], point => point, 8), null);
  assert.equal(projectedSegmentPoint([0, 0], [1, 0], [0, 0], () => [Infinity, 0], 8), null);
  assert.equal(projectedSegmentPoint([0, 0], [1, 0], [NaN, 0], point => point, 8), null);
});
