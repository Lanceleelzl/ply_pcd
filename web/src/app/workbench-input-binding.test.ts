import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchInputDelegate } from './workbench-input-binding.ts';

test('routes picking before clipping and blocks navigation for active interactions', () => {
  const calls: string[] = [];
  const canvas = { style: { cursor: '' } } as HTMLCanvasElement;
  const clipping = {
    dragging: true,
    pointerMove: () => { calls.push('clip-move'); return true; },
    pointerLeave: () => calls.push('clip-leave'),
    pointerDown: () => { calls.push('clip-down'); return true; },
    pointerUp: () => calls.push('clip-up'),
  };
  const query = { active: true, hovered: true, dragging: false, pointerDown: () => { calls.push('query-down'); return true; } };
  const delegate = createWorkbenchInputDelegate({
    canvas, clipping: () => clipping, query: () => query,
    clippingInteractionActive: () => false, movingGizmoHovered: () => false,
    clippingGizmoHovered: () => false, gizmoTransforming: () => false,
    syncClipping: () => calls.push('sync'),
  });
  assert.equal(delegate.pointerMove?.({} as PointerEvent), true);
  assert.equal(canvas.style.cursor, 'grabbing');
  assert.equal(delegate.pointerDown?.({} as PointerEvent), true);
  delegate.pointerUp?.({} as PointerEvent);
  assert.equal(delegate.navigationBlocked?.({ button: 0 } as PointerEvent), true);
  assert.equal(delegate.dragBlocked?.(), false);
  assert.deepEqual(calls, ['clip-move', 'query-down', 'clip-up', 'sync']);
});
