import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchViewState, setWorkbenchHelp } from './workbench-view-state.ts';

test('creates and updates view state without DOM access', () => {
  const state = createWorkbenchViewState();
  setWorkbenchHelp(state, '工具提示');
  assert.equal(state.help, '工具提示');
  assert.equal(state.roleSummary, '');
});
