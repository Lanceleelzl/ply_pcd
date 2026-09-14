import assert from 'node:assert/strict';
import test from 'node:test';
import { openOriginPlanes } from './inspector-tool-toggle.ts';

test('opening origin planes closes clipping and query tools', () => {
  const state = { clipping: true, originPlanes: false, query: true };
  let closed = 0; let refreshed = 0;
  openOriginPlanes(state, () => { closed += 1; }, () => { refreshed += 1; });
  assert.deepEqual(state, { clipping: false, originPlanes: true, query: true });
  assert.equal(closed, 1);
  assert.equal(refreshed, 1);
});
