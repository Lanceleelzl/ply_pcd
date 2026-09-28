import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDirectory } from './directory-selection.ts';

test('directory picker preserves sorted relative paths for nested dataset files', async context => {
  const file = (name: string) => ({ kind: 'file' as const, name,
    async getFile() { return new File([name], name); } });
  const nested = { kind: 'directory' as const, name: 'chunks',
    async *values() { yield file('2.webp'); yield file('1.webp'); } };
  const root = { kind: 'directory' as const, name: 'scene',
    async *values() { yield file('lod-meta.json'); yield nested; } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    showDirectoryPicker: async () => root,
  } });
  context.after(() => Reflect.deleteProperty(globalThis, 'window'));
  let fallback = 0;
  const selected = await pickDirectory(() => { fallback++; });
  assert.deepEqual(selected?.paths, [
    'scene/chunks/1.webp', 'scene/chunks/2.webp', 'scene/lod-meta.json',
  ]);
  assert.deepEqual(selected?.files.map(item => item.name), ['1.webp', '2.webp', 'lod-meta.json']);
  assert.equal(fallback, 0);
});

test('directory selection falls back only if the browser lacks the picker', async context => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  context.after(() => Reflect.deleteProperty(globalThis, 'window'));
  let fallback = 0;
  assert.equal(await pickDirectory(() => { fallback++; }), null);
  assert.equal(fallback, 1);
});
