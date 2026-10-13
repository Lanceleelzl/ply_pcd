import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navigationVector } from './SceneNavigationController.ts';

test('diagonal movement stays at the selected speed', () => {
  const vector = navigationVector(new Set(['KeyW', 'KeyD']), 10, 1 / 60);
  assert.ok(Math.abs(Math.hypot(...vector) - 10 / 60) < 1e-9);
});

test('opposing directions cancel and stalled frames are capped', () => {
  assert.deepEqual(navigationVector(new Set(['KeyW', 'KeyS']), 10, 1), [0, 0, 0]);
  assert.deepEqual(navigationVector(new Set(['KeyW']), 10, 2), [1, 0, 0]);
});
