import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelledRegistrationStatus, registrationStatus } from './registration-status.ts';

test('keeps distinct cancelled and restored status messages', () => {
  assert.match(cancelledRegistrationStatus(null), /任务已终止/);
  assert.match(cancelledRegistrationStatus({} as never), /未收敛/);
  assert.equal(registrationStatus.restored, '已恢复最近一次配准结果。');
});
