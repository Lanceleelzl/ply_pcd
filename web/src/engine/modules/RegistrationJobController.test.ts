import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegistrationJobController } from './RegistrationJobController.ts';
import type { RegistrationRequest } from '../../api/contracts';

const request = {} as RegistrationRequest;
function events() {
  const running: boolean[] = [];
  const completed: string[] = [];
  const statuses: string[] = [];
  return { running, completed, statuses, callbacks: {
    runningChanged: (value: boolean) => running.push(value),
    statusChanged: (value: string) => statuses.push(value),
    succeeded: (_result: unknown, id: string) => completed.push(id),
    cancelled: () => {}, progressChanged: () => {},
  } };
}

test('a destroyed job controller never submits another request or changes view state', async context => {
  const calls = context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const e = events();
  const controller = new RegistrationJobController(e.callbacks);
  controller.destroy();
  await assert.rejects(controller.run('session', request), { name: 'AbortError' });
  assert.equal(calls.mock.callCount(), 0);
  assert.deepEqual(e.running, []);
  assert.deepEqual(e.statuses, []);
});

test('a result arriving after teardown cannot publish success', async context => {
  let resultRequested!: () => void;
  const waiting = new Promise<void>(resolve => { resultRequested = resolve; });
  let deliverResult!: (response: Response) => void;
  const result = new Promise<Response>(resolve => { deliverResult = resolve; });
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/register')) return Response.json({ job_id: 'job', status_url: '/status', progress_url: '/events' });
    if (url === '/status') return Response.json({ status: 'succeeded', result_url: '/result' });
    resultRequested();
    return result;
  });
  const e = events();
  const controller = new RegistrationJobController(e.callbacks);
  const pending = controller.run('session', request);
  await waiting;
  controller.destroy();
  deliverResult(Response.json({}));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(e.completed, []);
  assert.deepEqual(e.running, [true]);
});

test('successful registration publishes one result and restores editing', async context => {
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/register')) return Response.json({ job_id: 'job', status_url: '/status', progress_url: '/events' });
    if (url === '/status') return Response.json({ status: 'succeeded', result_url: '/result' });
    return Response.json({});
  });
  const e = events();
  const controller = new RegistrationJobController(e.callbacks);
  await controller.run('session', request);
  assert.deepEqual(e.completed, ['job']);
  assert.deepEqual(e.running, [true, false]);
  assert.equal(controller.running, false);
  controller.destroy();
});

test('invalid task status stops polling and restores editing', async context => {
  const calls = context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/register')) return Response.json({ job_id: 'job', status_url: '/status', progress_url: '/events' });
    return Response.json({});
  });
  const e = events();
  const controller = new RegistrationJobController(e.callbacks);
  await assert.rejects(controller.run('session', request), /无效状态/);
  assert.equal(calls.mock.callCount(), 2);
  assert.deepEqual(e.running, [true, false]);
  controller.destroy();
});
