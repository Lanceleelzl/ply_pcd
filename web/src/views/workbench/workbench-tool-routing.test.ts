import assert from 'node:assert/strict';
import test from 'node:test';
import { isMovingModelVisible, resolveWorkbenchTool } from './workbench-tool-routing.ts';

test('prioritizes clipping, query, and then model editing', () => {
  assert.equal(resolveWorkbenchTool({ clippingInteractionActive: true, queryActive: true, running: false, movingVisible: true }), 'clipping');
  assert.equal(resolveWorkbenchTool({ clippingInteractionActive: false, queryActive: true, running: false, movingVisible: true }), 'coordinate-query');
  assert.equal(resolveWorkbenchTool({ clippingInteractionActive: false, queryActive: false, running: false, movingVisible: true }), 'model-transform');
});

test('disables model editing while running or hidden', () => {
  assert.equal(resolveWorkbenchTool({ clippingInteractionActive: false, queryActive: false, running: true, movingVisible: true }), 'idle');
  assert.equal(resolveWorkbenchTool({ clippingInteractionActive: false, queryActive: false, running: false, movingVisible: false }), 'idle');
  assert.equal(isMovingModelVisible({ a: true, b: false }, 'a'), true);
});
