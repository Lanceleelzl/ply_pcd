import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleClippingPanel } from './clipping-panel-toggle.ts';

test('opening clipping closes origin planes and reports lifecycle callbacks', () => {
  const state = { clipping: false, originPlanes: true };
  const calls: string[] = [];
  assert.equal(toggleClippingPanel(state, () => calls.push('open'), () => calls.push('close')), true);
  assert.deepEqual(state, { clipping: true, originPlanes: false });
  assert.deepEqual(calls, ['open']);
  assert.equal(toggleClippingPanel(state, () => calls.push('open'), () => calls.push('close')), false);
  assert.deepEqual(calls, ['open', 'close']);
});
