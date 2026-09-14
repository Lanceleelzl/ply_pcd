import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOriginPlaneVisibility } from './origin-plane-lifecycle.ts';

test('synchronizes origin plane visibility with toolbar and conflicting tools', () => {
  const state = { originPlanes: false, clipping: true };
  const calls: string[] = [];
  applyOriginPlaneVisibility(state, true, () => calls.push('query-close'), () => calls.push('refresh'), value => calls.push(`toolbar:${value}`));
  assert.deepEqual(state, { originPlanes: true, clipping: false });
  assert.deepEqual(calls, ['toolbar:true', 'query-close', 'refresh']);
});
