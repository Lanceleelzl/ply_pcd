import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadLength, saveEditorResponse } from './editor-download.ts';

function sink(failWrite = false, failClose = false) {
  const calls: string[] = [];
  return { calls, writable: {
    async write() { calls.push('write'); if (failWrite) throw new Error('disk full'); },
    async close() { calls.push('close'); if (failClose) throw new Error('close failed'); },
    async abort() { calls.push('abort'); },
  } };
}

test('successful streaming closes only after all declared bytes arrive', async () => {
  const { calls, writable } = sink();
  const progress: number[] = [];
  await saveEditorResponse(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Length': '2' } }),
    writable, new AbortController().signal, loaded => progress.push(loaded));
  assert.deepEqual(calls, ['write', 'close']);
  assert.deepEqual(progress, [2]);
});

test('truncated and oversized streams abort instead of committing', async () => {
  for (const length of ['1', '3']) {
    const { calls, writable } = sink();
    await assert.rejects(saveEditorResponse(new Response(new Uint8Array([1, 2]),
      { headers: { 'Content-Length': length } }), writable, new AbortController().signal, () => {}));
    assert.deepEqual(calls, ['write', 'abort']);
  }
});

test('write and close failures abort and retain the original failure', async () => {
  for (const close of [false, true]) {
    const { calls, writable } = sink(!close, close);
    await assert.rejects(saveEditorResponse(new Response(new Uint8Array([1])), writable,
      new AbortController().signal, () => {}), new RegExp(close ? 'close failed' : 'disk full'));
    assert.equal(calls.at(-1), 'abort');
  }
});

test('cancellation wakes a pending read and aborts without committing', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const { calls, writable } = sink();
  const saving = saveEditorResponse(response, writable, controller.signal, () => {});
  controller.abort();
  await assert.rejects(saving, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ['abort']);
});

test('network failure aborts local writing', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('network failed')); } }));
  const { calls, writable } = sink();
  await assert.rejects(saveEditorResponse(response, writable, new AbortController().signal, () => {}), /network failed/);
  assert.deepEqual(calls, ['abort']);
});

test('a failed attempt can be followed by a successful independent save', async () => {
  const failed = sink(true);
  await assert.rejects(saveEditorResponse(new Response(new Uint8Array([1])), failed.writable,
    new AbortController().signal, () => {}), /disk full/);
  const retry = sink();
  await saveEditorResponse(new Response(new Uint8Array([1])), retry.writable,
    new AbortController().signal, () => {});
  assert.deepEqual(retry.calls, ['write', 'close']);
});

test('already cancelled saves never write and close is announced only on success', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, writable } = sink();
  await assert.rejects(saveEditorResponse(new Response(new Uint8Array([1])), writable,
    controller.signal, () => {}, () => calls.push('closing')), { name: 'AbortError' });
  assert.deepEqual(calls, ['abort']);
  const success = sink();
  await saveEditorResponse(new Response(new Uint8Array([1])), success.writable,
    new AbortController().signal, () => {}, () => success.calls.push('closing'));
  assert.deepEqual(success.calls, ['write', 'closing', 'close']);
});

test('encoded and invalid lengths do not produce a misleading percentage', () => {
  assert.equal(downloadLength(new Response(null, { headers: { 'Content-Length': '10', 'Content-Encoding': 'gzip' } })), null);
  for (const length of ['-1', 'abc', '1.5', '0'])
    assert.equal(downloadLength(new Response(null, { headers: { 'Content-Length': length } })), null);
});
