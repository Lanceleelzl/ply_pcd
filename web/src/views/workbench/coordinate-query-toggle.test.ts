import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleCoordinateQuery } from './coordinate-query-toggle.ts';

test('opening coordinate query closes other inspector tools', () => {
  const state = { query: false, clipping: true, originPlanes: true };
  let opened = 0; let closed = 0;
  assert.equal(toggleCoordinateQuery(state, () => { opened += 1; }, () => { closed += 1; }), true);
  assert.deepEqual(state, { query: true, clipping: false, originPlanes: false });
  assert.equal(opened, 1);
  assert.equal(toggleCoordinateQuery(state, () => { opened += 1; }, () => { closed += 1; }), false);
  assert.equal(closed, 1);
});
