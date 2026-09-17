import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadStreamCache, waitForSession } from './registration-api.ts';
import type { StreamCacheDownloadHandle, StreamCacheDownloadProgress } from './registration-api.ts';

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

test('stream cache download aborts an incomplete swap file and retries with the same handle', async context => {
  const writes: Uint8Array[][] = [[], []];
  const closed = [false, false];
  const aborted = [false, false];
  let writerIndex = 0;
  const handle: StreamCacheDownloadHandle = {
    async createWritable() {
      const index = writerIndex++;
      return {
        async write(value: Uint8Array) { writes[index].push(value); },
        async close() { closed[index] = true; },
        async abort() { aborted[index] = true; },
      };
    },
  };
  let pickerCalls = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    showSaveFilePicker: async () => { pickerCalls++; return handle; },
  }});
  context.after(() => Reflect.deleteProperty(globalThis, 'window'));

  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requests++;
    if (requests === 1) {
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.error(new Error('network lost'));
        },
      }), { headers: { 'X-Cache-Source-Bytes': '4', 'X-Cache-File-Count': '2' } });
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'X-Cache-Source-Bytes': '4', 'X-Cache-File-Count': '2' },
    });
  });

  let selected: StreamCacheDownloadHandle | undefined;
  await assert.rejects(downloadStreamCache('session', 'a', 'workspace', {
    onHandle: value => { selected = value; },
  }), /network lost/);
  assert.equal(selected, handle);
  assert.equal(aborted[0], true);
  assert.equal(closed[0], false);

  const progress: StreamCacheDownloadProgress[] = [];
  const result = await downloadStreamCache('session', 'a', 'workspace', {
    handle: selected,
    onProgress: value => progress.push(value),
  });
  assert.equal(result, handle);
  assert.equal(pickerCalls, 1);
  assert.equal(closed[1], true);
  assert.equal(aborted[1], false);
  assert.equal(progress.at(-1)?.receivedBytes, 4);
  assert.equal(progress.at(-1)?.sourceBytes, 4);
  assert.equal(progress.at(-1)?.fileCount, 2);
});
