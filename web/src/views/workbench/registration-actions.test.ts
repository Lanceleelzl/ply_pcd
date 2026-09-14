import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelRegistration, setRegistrationProgressVisible } from './registration-actions.ts';

test('updates activity, job and result progress visibility together', () => {
  const activity = { running: false, cancelling: false, queryActive: false, progress: false, editingLocked: false };
  const calls: string[] = [];
  const jobs = { setProgressVisible: (value: boolean) => calls.push(`job:${value}`) } as never;
  const results = { setProgressVisible: (value: boolean, running: boolean) => calls.push(`result:${value}:${running}`) } as never;
  setRegistrationProgressVisible(true, activity, jobs, results);
  assert.equal(activity.progress, true);
  assert.deepEqual(calls, ['job:true', 'result:true:false']);
});

test('ignores cancellation when no job is running', async () => {
  const activity = { running: false, cancelling: false, queryActive: false, progress: false, editingLocked: false };
  let called = false;
  await cancelRegistration(activity, { cancel: async () => { called = true; } } as never, () => {});
  assert.equal(called, false);
});
