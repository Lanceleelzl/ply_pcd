import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as pc from 'playcanvas';
import { TransformGizmoInput } from './TransformGizmoInput.ts';

test('translation wins overlapping hits and dragging locks the active handle', () => {
  const translate = Object.assign(new pc.EventHandler(), { mouseButtons: [true, true, true] });
  const rotate = Object.assign(new pc.EventHandler(), { mouseButtons: [true, true, true] });
  const changes: boolean[] = [];
  const input = new TransformGizmoInput(
    translate as unknown as pc.TransformGizmo, rotate as unknown as pc.TransformGizmo,
    active => changes.push(active),
  );
  const hover = (gizmo: typeof translate, hit: boolean) => gizmo.fire(pc.Gizmo.EVENT_POINTERMOVE, 0, 0, hit ? {} : null);
  assert.deepEqual(translate.mouseButtons, [true, false, false]);
  assert.deepEqual(rotate.mouseButtons, [false, false, false]);
  assert.equal(input.hovered, false);
  hover(rotate, true);
  assert.equal(rotate.mouseButtons[0], true);
  hover(translate, true);
  assert.equal(rotate.mouseButtons[0], false);
  translate.fire(pc.TransformGizmo.EVENT_TRANSFORMSTART);
  hover(translate, false);
  assert.equal(rotate.mouseButtons[0], false);
  translate.fire(pc.TransformGizmo.EVENT_TRANSFORMEND);
  assert.equal(rotate.mouseButtons[0], true);
  rotate.fire(pc.TransformGizmo.EVENT_TRANSFORMSTART);
  hover(rotate, false);
  hover(translate, true);
  assert.equal(translate.mouseButtons[0], false);
  assert.equal(rotate.mouseButtons[0], true);
  rotate.fire(pc.TransformGizmo.EVENT_TRANSFORMEND);
  assert.deepEqual(changes, [true, false, true, false]);
  hover(translate, false);
  assert.equal(input.hovered, false);
  assert.equal(rotate.mouseButtons[0], false);
  input.destroy();
  input.destroy();
  hover(translate, true);
  rotate.fire(pc.TransformGizmo.EVENT_TRANSFORMSTART);
  assert.equal(input.hovered, false);
  assert.deepEqual(changes, [true, false, true, false]);
});
