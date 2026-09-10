import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForSession } from './registration-api.ts';

test('ready session returns its data and encodes the session identifier', async context => {
  const session = { status: 'ready', model_a_preview_url: '/a' };
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json(session));
  const statuses: string[] = [];
  assert.deepEqual(await waitForSession('a/b', new AbortController().signal, value => statuses.push(value)), session);
  assert.equal(request.mock.calls[0].arguments[0], '/api/v2/registration-sessions/a%2Fb');
  assert.deepEqual(statuses, ['ready']);
});

test('HTTP failures stop polling and preserve the server message', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json({ detail: '会话不存在' }, { status: 404 }));
  await assert.rejects(waitForSession('missing', new AbortController().signal, () => {}), /会话不存在/);
  assert.equal(request.mock.callCount(), 1);
});

test('non-JSON failures report HTTP status', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(waitForSession('id', new AbortController().signal, () => {}), /HTTP 503/);
});

test('failed previews and malformed responses stop loading', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'failed', error: '预览失败' }));
  await assert.rejects(waitForSession('id', new AbortController().signal, () => {}), /预览失败/);
  request.mock.mockImplementation(async () => Response.json({}));
  await assert.rejects(waitForSession('id', new AbortController().signal, () => {}), /缺少预览状态/);
});

test('an already cancelled load never sends a request', async context => {
  const request = context.mock.method(globalThis, 'fetch');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForSession('id', controller.signal, () => {}), { name: 'AbortError' });
  assert.equal(request.mock.callCount(), 0);
});

test('cancelling between polls clears the wait and prevents further requests', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'queued' }));
  const controller = new AbortController();
  let notifyStatus!: () => void;
  const notified = new Promise<void>(resolve => { notifyStatus = resolve; });
  const pending = waitForSession('id', controller.signal, notifyStatus);
  await notified;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  context.mock.timers.tick(2000);
  assert.equal(request.mock.callCount(), 1);
});

test('queued previews are polled until ready', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => Response.json({ status: ++requests === 1 ? 'queued' : 'ready' }));
  let notifyStatus!: () => void;
  const notified = new Promise<void>(resolve => { notifyStatus = resolve; });
  const statuses: string[] = [];
  const pending = waitForSession('id', new AbortController().signal, value => {
    statuses.push(value);
    notifyStatus();
  });
  await notified;
  context.mock.timers.tick(1000);
  assert.equal((await pending).status, 'ready');
  assert.deepEqual(statuses, ['queued', 'ready']);
});
