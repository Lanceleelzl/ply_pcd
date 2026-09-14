import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegistrationJobController } from './RegistrationJobController.ts';
import type { RegistrationRequest } from '../../api/contracts';

const request = {} as RegistrationRequest;

test('closed progress streams cannot publish iterations or close a replacement stream', async context => {
  class ProgressSource extends EventTarget {
    static instances: ProgressSource[] = [];
    closed = false;
    constructor(readonly url: string) {
      super();
      ProgressSource.instances.push(this);
    }
    close() { this.closed = true; }
    iteration(value: number) {
      this.dispatchEvent(new MessageEvent('iteration', { data: JSON.stringify({ iteration: value }) }));
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: ProgressSource });
  context.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor);
    else Reflect.deleteProperty(globalThis, 'EventSource');
  });
  let statusRequested!: () => void;
  const waiting = new Promise<void>(resolve => { statusRequested = resolve; });
  let finish!: (response: Response) => void;
  const status = new Promise<Response>(resolve => { finish = resolve; });
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/register')) return Response.json({ job_id: 'job', status_url: '/status', progress_url: '/events' });
    statusRequested();
    return status;
  });
  const iterations: number[] = [];
  const parent = new AbortController();
  const e = events();
  const controller = new RegistrationJobController({ ...e.callbacks, progressChanged: value => iterations.push(value.iteration) }, parent.signal);
  context.after(() => controller.destroy());
  controller.setProgressVisible(true);
  const pending = controller.run('session', request);
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  await waiting;
  const first = ProgressSource.instances[0];
  first.iteration(1);
  controller.setProgressVisible(false);
  assert.equal(first.closed, true);
  controller.setProgressVisible(true);
  const second = ProgressSource.instances[1];
  // Model callbacks already queued when the old connection was closed.
  first.iteration(99);
  first.dispatchEvent(new Event('terminal'));
  const replacementClosedByOldStream = second.closed;
  second.iteration(2);
  parent.abort();
  controller.setProgressVisible(true);
  second.iteration(3);
  finish(Response.json({ status: 'cancelled' }));
  await stopped;
  assert.deepEqual(iterations, [1, 2]);
  assert.equal(replacementClosedByOldStream, false);
  assert.equal(second.closed, true);
  controller.setProgressVisible(true);
  assert.equal(ProgressSource.instances.length, 2);
  assert.deepEqual(e.running, [true]);
});

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

test('authenticated progress uses a fetch stream and publishes SSE iterations', async context => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => 'secret-key' },
  });
  context.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  });

  let progressPublished!: () => void;
  const published = new Promise<void>(resolve => { progressPublished = resolve; });
  const calls: Array<{ url: string; key: string | null }> = [];
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), key: headers.get('X-API-Key') });
    if (String(url).endsWith('/register')) {
      return Response.json({ job_id: 'job', status_url: '/status', progress_url: '/events' });
    }
    if (String(url).startsWith('/events')) {
      return new Response('event: iteration\ndata: {"iteration":3}\n\nevent: terminal\ndata: {}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (url === '/status') {
      await published;
      return Response.json({ status: 'succeeded', result_url: '/result' });
    }
    return Response.json({});
  });
  const iterations: number[] = [];
  const e = events();
  const controller = new RegistrationJobController({
    ...e.callbacks,
    progressChanged: value => { iterations.push(value.iteration); progressPublished(); },
  });
  controller.setProgressVisible(true);
  await controller.run('session', request);
  assert.deepEqual(iterations, [3]);
  assert.ok(calls.some(call => call.url.startsWith('/events?from_latest=true')));
  assert.ok(calls.every(call => call.key === 'secret-key'));
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
