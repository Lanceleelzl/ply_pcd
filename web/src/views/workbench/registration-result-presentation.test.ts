import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistrationResult } from '../../api/contracts';
import { registrationResultGroups } from './registration-result-presentation.ts';

const result: RegistrationResult = {
  recommended_matrix: {name: '', formula: '', value: [[0]]},
  moving_model: 'b', moving_local_to_fixed_local: [[0]],
  a_to_b: [[1.123456789012]], b_to_a: [[2]],
  file_a_to_b: [[3]], file_b_to_a: [[4]],
  metrics: {final_rms: 0, final_point_count: 1, elapsed_seconds: 0},
};

test('business and file matrices follow output direction independently of ICP role', () => {
  const before = structuredClone(result);
  for (const [direction, source, target, values] of [
    ['a_to_b', 'a', 'b', ['1.123456789012', '2.000000000000', '3.000000000000', '4.000000000000']],
    ['b_to_a', 'b', 'a', ['2.000000000000', '1.123456789012', '4.000000000000', '3.000000000000']],
  ] as const) {
    const [business, file] = registrationResultGroups(result, direction);
    assert.deepEqual([business.forward, business.inverse, file.forward, file.inverse], values);
    assert.equal(business.formula, `p_business_${target} = M_business_${source}_to_${target} × p_business_${source}`);
    assert.equal(file.formula, `p_file_${target} = M_file_${source}_to_${target} × p_file_${source}`);
    assert.ok(business.title.includes(`模型 ${source.toUpperCase()} → 模型 ${target.toUpperCase()}`));
    assert.ok(file.title.includes(`模型 ${source.toUpperCase()} → 模型 ${target.toUpperCase()}`));
  }
  assert.deepEqual(result, before);
});

test('empty results and incomplete optional file matrices do not fabricate groups', () => {
  assert.deepEqual(registrationResultGroups(null, 'a_to_b'), []);
  for (const missing of ['file_a_to_b', 'file_b_to_a'] as const) {
    for (const direction of ['a_to_b', 'b_to_a']) {
      assert.deepEqual(registrationResultGroups({...result, [missing]: undefined}, direction).map(group => group.key), ['business']);
    }
  }
});
