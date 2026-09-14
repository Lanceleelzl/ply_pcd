import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistrationResult, RegistrationSession } from '../api/contracts';
import { createIcpParameterValues } from '../views/workbench/icp-parameter-state.ts';
import { applyRestoredRegistration } from './workbench-history-restoration.ts';

test('applies restored roles, known ICP parameters, result and camera in order', () => {
  const calls: string[] = [];
  const role = { moving: 'auto', direction: 'a_to_b' } as const;
  const mutableRole = { ...role };
  const icp = createIcpParameterValues();
  const registration = {
    job_id: 'job-1', output_direction: 'b_to_a',
    parameters: { overlap: 0.75, random_seed: 42, ignored: 9 },
  } as unknown as NonNullable<RegistrationSession['registrations']>[number];
  const result = { moving_model: 'b' } as RegistrationResult;

  applyRestoredRegistration(result, registration, {
    role: mutableRole, icp,
    refreshRoles: reset => calls.push(`roles:${reset}`),
    showResult: (_, jobId) => calls.push(`result:${jobId}`),
    setStatus: status => calls.push(`status:${status}`),
    fitCamera: () => calls.push('fit'),
  });

  assert.deepEqual(mutableRole, { moving: 'b', direction: 'b_to_a' });
  assert.equal(icp.overlap, '0.75');
  assert.equal(icp.random_seed, '42');
  assert.equal('ignored' in icp, false);
  assert.deepEqual(calls, ['roles:true', 'result:job-1', 'status:已恢复最近一次配准结果。', 'fit']);
});
