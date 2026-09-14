import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRegistrationRequest, resolveMovingModel } from './registration-request.ts';

test('builds a business registration request with progress events enabled', () => {
  const request = buildRegistrationRequest({
    initialMovingLocalToFixedLocal: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    outputDirection: 'b_to_a', movingModel: 'b', minRmsDecrease: '0.001', samplingLimit: '50000', overlap: '1', randomSeed: '42',
  });
  assert.equal(request.coordinate_space, 'business');
  assert.equal(request.show_registration_progress, true);
  assert.equal(request.sampling_limit, 50000);
  assert.equal(request.initial_source, 'manual');
});

test('resolves automatic moving model from session recommendation', () => {
  assert.equal(resolveMovingModel('auto', 'b'), 'b');
  assert.equal(resolveMovingModel('a', 'b'), 'a');
});
