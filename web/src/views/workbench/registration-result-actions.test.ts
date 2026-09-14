import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationResultActions } from './registration-result-actions.ts';

test('applies progress matrix before publishing progress', () => {
  const calls: string[] = [];
  const actions = createRegistrationResultActions({
    setMovingLocalToFixedLocal: () => calls.push('matrix'), updateProgress: () => calls.push('progress'),
    showResult: () => calls.push('show'), complete: () => calls.push('complete'),
  });
  actions.progress({ iteration: 1, moving_local_to_fixed_local: [], rms: 0, point_count: 1, elapsed_seconds: 0 } as never);
  assert.deepEqual(calls, ['matrix', 'progress']);
});
