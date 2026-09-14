import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchLifecycle } from './workbench-lifecycle.ts';

test('aborts and disposes workbench resources with parent signal', () => {
  const parent = new AbortController();
  const lifecycle = createWorkbenchLifecycle(parent.signal);
  let released = 0;
  lifecycle.resources.add(() => { released += 1; });
  parent.abort();
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(released, 1);
});
