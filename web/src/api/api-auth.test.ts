import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFetch, authenticateRequest, getApiKey, setApiKey } from './api-auth.ts';

test('API key is stored per session and added to fetch and XHR headers', async t => {
  const values = new Map<string, string>();
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
    key: new Headers(init?.headers).get('X-API-Key'),
  })));
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }});
  t.after(() => Reflect.deleteProperty(globalThis, 'sessionStorage'));

  setApiKey(' secret ');
  assert.equal(getApiKey(), 'secret');
  const response = await apiFetch('/api/v2/test');
  assert.equal((await response.json()).key, 'secret');
  const setRequestHeader = t.mock.fn<(name: string, value: string) => void>();
  const request = { setRequestHeader } as unknown as XMLHttpRequest;
  authenticateRequest(request);
  assert.deepEqual(setRequestHeader.mock.calls[0].arguments, ['X-API-Key', 'secret']);
  setApiKey('');
  assert.equal(getApiKey(), '');
});
