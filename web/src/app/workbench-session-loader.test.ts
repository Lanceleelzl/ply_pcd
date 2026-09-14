import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkbenchSession } from './workbench-session-loader.ts';

test('requires an abort signal before returning loaded session data', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => loadWorkbenchSession('session', controller.signal, () => {}));
});
