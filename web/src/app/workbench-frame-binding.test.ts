import assert from 'node:assert/strict';
import test from 'node:test';
import { bindWorkbenchFrameUpdates } from './workbench-frame-updater.ts';

test('returns an explicit frame listener disposer', () => {
  const calls: string[] = [];
  const app = { on: () => calls.push('on'), off: () => calls.push('off') } as never;
  const dispose = bindWorkbenchFrameUpdates(app, () => {});
  dispose();
  assert.deepEqual(calls, ['on', 'off']);
});
