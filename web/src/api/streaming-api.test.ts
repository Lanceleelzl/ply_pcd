import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadStreamingCache } from './streaming-api.ts';

test('failure to open the output file cancels the download stream', async context => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  context.after(() => Reflect.deleteProperty(globalThis, 'window'));
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  context.mock.method(globalThis, 'fetch', async () => new Response(body));
  await assert.rejects(downloadStreamingCache('task', 'model.ply', {
    handle: { async createWritable() { throw new Error('disk unavailable'); } },
  }), /disk unavailable/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('download failure aborts the partial file and retry reuses the selected handle', async context => {
  let pickerCalls = 0;
  let writes = 0;
  let aborted = 0;
  let closed = 0;
  const handle = { async createWritable() { return {
    async write(_value: Uint8Array) { if (++writes === 1) throw new Error('write failed'); },
    async close() { closed++; },
    async abort() { aborted++; },
  }; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    showSaveFilePicker: async () => { pickerCalls++; return handle; },
  } });
  context.after(() => Reflect.deleteProperty(globalThis, 'window'));
  context.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])));
  let selected: typeof handle | undefined;
  await assert.rejects(downloadStreamingCache('task', 'model.ply', {
    onHandle: value => { selected = value; },
  }), /write failed/);
  assert.equal(aborted, 1);
  assert.equal(closed, 0);
  const progress: number[] = [];
  await downloadStreamingCache('task', 'model.ply', {
    handle: selected, onProgress: value => progress.push(value),
  });
  assert.equal(pickerCalls, 1);
  assert.equal(closed, 1);
  assert.equal(progress.at(-1), 3);
});

test('save dialog uses a safe original name with the local download timestamp', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 24, 10, 9, 8).getTime() });
  let suggestedName = '';
  const handle = { async createWritable() { return {
    async write() {}, async close() {}, async abort() {},
  }; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    showSaveFilePicker: async (options: { suggestedName: string }) => {
      suggestedName = options.suggestedName; return handle;
    },
  } });
  context.after(() => Reflect.deleteProperty(globalThis, 'window'));
  context.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1])));
  await downloadStreamingCache('task', 'scan:west?.ply');
  assert.equal(suggestedName, 'scan_west_.ply-streamed-sog-20260924-100908.zip');
});
