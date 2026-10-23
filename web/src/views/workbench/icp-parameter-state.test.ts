import assert from 'node:assert/strict';
import test from 'node:test';
import { createIcpParameterValues, updateIcpParameter } from './icp-parameter-state.ts';

test('creates stable ICP defaults and updates known fields', () => {
  const values = createIcpParameterValues();
  updateIcpParameter(values, 'sampling_limit', '10000');
  updateIcpParameter(values, 'unknown', 'ignored');
  assert.equal(values.sampling_limit, '10000');
  assert.equal(values.adjust_scale, 'false');
  updateIcpParameter(values, 'adjust_scale', 'true');
  assert.equal(values.adjust_scale, 'true');
  assert.equal(Object.keys(values).length, 5);
});
