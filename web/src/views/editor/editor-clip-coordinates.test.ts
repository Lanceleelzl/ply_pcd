import assert from 'node:assert/strict';
import test from 'node:test';
import { clipToLocal, clipToScene } from './editor-clip-coordinates.ts';

test('display clipping preserves scene coordinates across a large render origin', () => {
  const origin: [number, number, number] = [500000, 3000000, 75];
  const point: [number, number, number] = [500120, 3000040, 80];
  assert.deepEqual(clipToLocal(point, origin), [120, 40, 5]);
  assert.deepEqual(clipToScene(clipToLocal(point, origin), origin), point);
});
