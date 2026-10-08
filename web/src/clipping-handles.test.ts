import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ClippingHandles } from './clipping-handles.ts';

test('revealed boundary stays selectable when the pointer crosses to the opposite half axis', () => {
  const max = { axis: 'z', side: 'max' };
  const min = { axis: 'z', side: 'min' };
  let picked: typeof max | null = null;
  let axisTarget: typeof max | null = min;
  const handles = Object.assign(Object.create(ClippingHandles.prototype), {
    drag: null, revealedHandle: max,
    pointerPosition: () => ({ x: 0, y: 0 }),
    getMode: () => 'axis',
    pick: () => picked,
    axisHoverTarget: () => axisTarget,
  });
  const event = {} as PointerEvent;
  handles.pointerMove(event);
  assert.equal(handles.revealedHandle, max);
  picked = max;
  assert.equal(handles.pointerMove(event), true);
  assert.equal(handles.revealedHandle, max);
  assert.equal(handles.hoveredHandle, max);
  picked = null;
  axisTarget = null;
  handles.pointerMove(event);
  assert.equal(handles.revealedHandle, null);
  axisTarget = min;
  handles.pointerMove(event);
  assert.equal(handles.revealedHandle, min);
});
