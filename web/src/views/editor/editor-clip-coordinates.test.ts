import assert from 'node:assert/strict';
import test from 'node:test';
import { clipToLocal, clipToScene, sliceClipBounds, transformedClipBounds } from './editor-clip-coordinates.ts';

test('display clipping preserves scene coordinates across a large render origin', () => {
  const origin: [number, number, number] = [500000, 3000000, 75];
  const point: [number, number, number] = [500120, 3000040, 80];
  assert.deepEqual(clipToLocal(point, origin), [120, 40, 5]);
  assert.deepEqual(clipToScene(clipToLocal(point, origin), origin), point);
});

test('quick slice uses the transformed scene range after rotation, scale and translation', () => {
  const bounds: { min: [number, number, number]; max: [number, number, number] } = {
    min: [0, 0, 0], max: [2, 4, 6],
  };
  const transform = { translation: [100, 200, 300] as [number, number, number],
    rotation_degrees: [0, 0, 90] as [number, number, number], scale: [2, 2, 2] as [number, number, number] };
  const range = transformedClipBounds(bounds, transform);
  range.min.forEach((value, axis) => assert.ok(Math.abs(value - [92, 200, 300][axis]) < 1e-9));
  range.max.forEach((value, axis) => assert.ok(Math.abs(value - [100, 204, 312][axis]) < 1e-9));
  const slice = sliceClipBounds(bounds, transform, 2, 2);
  slice.min.forEach((value, axis) => assert.ok(Math.abs(value - [92, 200, 305][axis]) < 1e-9));
  slice.max.forEach((value, axis) => assert.ok(Math.abs(value - [100, 204, 307][axis]) < 1e-9));
});
