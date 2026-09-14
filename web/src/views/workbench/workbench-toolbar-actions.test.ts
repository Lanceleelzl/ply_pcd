import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchToolbarHandler } from './workbench-toolbar-actions.ts';

test('dispatches model visibility with its model id', () => {
  const calls: string[] = [];
  const handler = createWorkbenchToolbarHandler({
    reset: () => calls.push('reset'), fit: () => calls.push('fit'),
    toggleClipping: () => calls.push('clipping'), toggleOriginPlanes: () => calls.push('origin-planes'),
    toggleQuery: () => calls.push('query'), setModelVisible: model => calls.push(`visibility:${model}`),
    toggleOrigin: model => { calls.push(`origin:${model}`); return true; },
    toggleGaussian: model => calls.push(`gaussian:${model}`),
  });
  handler({ type: 'visibility', model: 'b' });
  handler({ type: 'origin-axes', model: 'a' });
  assert.deepEqual(calls, ['visibility:b', 'origin:a']);
});

test('dispatches every command without DOM dependencies', () => {
  const calls: string[] = [];
  const handler = createWorkbenchToolbarHandler({
    reset: () => calls.push('reset'), fit: () => calls.push('fit'),
    toggleClipping: () => calls.push('clipping'), toggleOriginPlanes: () => calls.push('origin-planes'),
    toggleQuery: () => calls.push('query'), setModelVisible: () => calls.push('visibility'),
    toggleOrigin: () => false, toggleGaussian: () => calls.push('gaussian'),
  });
  handler({ type: 'reset' }); handler({ type: 'fit' }); handler({ type: 'clipping' });
  handler({ type: 'origin-planes' }); handler({ type: 'query' }); handler({ type: 'gaussian', model: 'a' });
  assert.deepEqual(calls, ['reset', 'fit', 'clipping', 'origin-planes', 'query', 'gaussian']);
});
