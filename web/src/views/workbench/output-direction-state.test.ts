import assert from 'node:assert/strict';
import test from 'node:test';
import { setOutputDirection } from './output-direction-state.ts';

test('invalidates result and query when output direction changes', () => {
  const state = { direction: 'a_to_b' as const };
  const calls: string[] = [];
  setOutputDirection(state, 'b_to_a', () => calls.push('result'), () => calls.push('query'));
  assert.equal(state.direction, 'b_to_a');
  assert.deepEqual(calls, ['result', 'query']);
});

test('does not invalidate unchanged output direction', () => {
  const state = { direction: 'a_to_b' as const };
  let calls = 0;
  setOutputDirection(state, 'a_to_b', () => { calls += 1; }, () => { calls += 1; });
  assert.equal(calls, 0);
});
