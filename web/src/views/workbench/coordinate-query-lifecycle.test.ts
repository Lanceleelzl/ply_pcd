import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCoordinateQueryLock } from './coordinate-query-lifecycle.ts';

test('applies query lock and closes conflicting tools', () => {
  const state = { queryActive: false };
  let closed = 0; let restored = 0; let refreshed = 0;
  applyCoordinateQueryLock(state, true, () => { closed += 1; }, () => { restored += 1; }, () => { refreshed += 1; });
  assert.deepEqual(state, { queryActive: true });
  assert.equal(closed, 1);
  assert.equal(refreshed, 1);
  applyCoordinateQueryLock(state, false, () => { closed += 1; }, () => { restored += 1; }, () => { refreshed += 1; });
  assert.equal(restored, 1);
});
