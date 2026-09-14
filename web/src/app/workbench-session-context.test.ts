import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchSessionContext } from './workbench-session-context.ts';

test('rejects sessions without metadata', () => {
  assert.throws(() => createWorkbenchSessionContext({} as never), /模型元数据/);
});
