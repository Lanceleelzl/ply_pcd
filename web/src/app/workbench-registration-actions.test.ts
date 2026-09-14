import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistrationRequest } from '../api/contracts';
import { createWorkbenchRegistrationActions } from './workbench-registration-actions.ts';

const request = { coordinate_space: 'business' } as RegistrationRequest;

function setup() {
  const calls: string[] = [];
  const activity = { editingLocked: false, running: false, queryActive: false, cancelling: false, progress: true };
  const controller = new AbortController();
  const actions = createWorkbenchRegistrationActions({
    sessionId: 'session-1', signal: controller.signal, activity,
    jobs: {
      setProgressVisible: (visible: boolean) => calls.push(`job-progress:${visible}`),
      run: async (sessionId: string, value: RegistrationRequest) => { calls.push(`run:${sessionId}:${value.coordinate_space}`); },
      cancel: async () => { calls.push('cancel'); },
    } as never,
    results: {
      begin: (visible: boolean) => calls.push(`begin:${visible}`),
      setProgressVisible: (visible: boolean, running: boolean) => calls.push(`result-progress:${visible}:${running}`),
    } as never,
    invalidateQuery: () => calls.push('invalidate'),
    buildRequest: () => request,
    setStatus: status => calls.push(`status:${status}`),
  });
  return { actions, activity, controller, calls };
}

test('prepares and runs registration in order', async () => {
  const state = setup();
  await state.actions.run();
  assert.deepEqual(state.calls, ['invalidate', 'begin:true', 'job-progress:true', 'run:session-1:business']);
});

test('routes progress state and ignores locked execution', async () => {
  const state = setup();
  state.activity.editingLocked = true;
  await state.actions.run();
  state.actions.setProgress(false);
  assert.deepEqual(state.calls, ['job-progress:false', 'result-progress:false:false']);
});

test('reports cancellation failure and restores cancellation control', async () => {
  const state = setup();
  state.activity.running = true;
  const failing = createWorkbenchRegistrationActions({
    sessionId: 'session-1', signal: state.controller.signal, activity: state.activity,
    jobs: { setProgressVisible: () => {}, run: async () => {}, cancel: async () => { throw new Error('network'); } } as never,
    results: { begin: () => {}, setProgressVisible: () => {} } as never,
    invalidateQuery: () => {}, buildRequest: () => request,
    setStatus: status => state.calls.push(status),
  });
  await failing.cancel();
  assert.equal(state.activity.cancelling, false);
  assert.equal(state.calls[0], '终止失败：Error: network');
});
