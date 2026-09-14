import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watch } from 'vue';
import { createWorkbenchActivity } from './workbench-activity.ts';

test('editing unlocks only after both registration and coordinate query end', () => {
  for (const first of ['query', 'registration']) {
    const { state, setRunning } = createWorkbenchActivity();
    assert.equal(state.editingLocked, false);
    state.queryActive = true;
    assert.equal(state.editingLocked, true);
    setRunning(true);
    if (first === 'query') state.queryActive = false;
    else setRunning(false);
    assert.equal(state.editingLocked, true);
    state.queryActive = false;
    setRunning(false);
    assert.equal(state.editingLocked, false);
  }
});

test('finishing a job clears cancellation without changing progress preference or query lock', () => {
  const { state, setRunning } = createWorkbenchActivity();
  setRunning(true);
  state.cancelling = true;
  state.progress = true;
  state.queryActive = true;
  setRunning(false);
  assert.equal(state.cancelling, false);
  assert.equal(state.progress, true);
  assert.equal(state.queryActive, true);
  assert.equal(state.editingLocked, true);
});

test('lock consumers update synchronously and stop receiving changes after disposal', () => {
  const { state, setRunning } = createWorkbenchActivity();
  const updates: boolean[] = [];
  const stop = watch(() => state.editingLocked, locked => updates.push(locked), { immediate: true, flush: 'sync' });
  setRunning(true);
  assert.deepEqual(updates, [false, true]);
  state.queryActive = true;
  setRunning(false);
  assert.deepEqual(updates, [false, true]);
  state.queryActive = false;
  assert.deepEqual(updates, [false, true, false]);
  stop();
  setRunning(true);
  assert.deepEqual(updates, [false, true, false]);
});

test('workbench instances do not share activity state', () => {
  const first = createWorkbenchActivity();
  const second = createWorkbenchActivity();
  first.setRunning(true);
  first.state.queryActive = true;
  first.state.progress = true;
  assert.equal(second.state.editingLocked, false);
  assert.equal(second.state.progress, false);
});
