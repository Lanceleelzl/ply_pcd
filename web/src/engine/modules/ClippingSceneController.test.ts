import assert from 'node:assert/strict';
import test from 'node:test';
import * as pc from 'playcanvas';
import { ClippingSceneController } from './ClippingSceneController.ts';
import { ClippingStateController } from './ClippingStateController.ts';

const axisState = (extent: number) => ({
  min: new pc.Vec3(-extent, -extent, -extent),
  max: new pc.Vec3(extent, extent, extent),
  minEnabled: { x: true, y: true, z: true },
  maxEnabled: { x: true, y: true, z: true },
});

function setup() {
  const state = new ClippingStateController();
  const joint = new pc.Entity('joint');
  const boxes = { a: new pc.Entity('a'), b: new pc.Entity('b') };
  [joint, boxes.a, boxes.b].forEach(box => box.setLocalScale(2, 2, 2));
  const pointCalls: unknown[][] = [];
  const gaussianCalls: unknown[][] = [];
  const controller = new ClippingSceneController({
    app: { drawLine: () => {} } as never,
    state, jointBox: joint, independentBoxes: boxes,
    pointMaterials: {
      a: { setClipState: (...args: unknown[]) => pointCalls.push(['a', ...args]) },
      b: { setClipState: (...args: unknown[]) => pointCalls.push(['b', ...args]) },
    } as never,
    gaussian: { setClipState: (...args: unknown[]) => gaussianCalls.push(args) } as never,
    scope: () => 'both',
    axisState: model => axisState(model === 'a' ? 1 : 10),
    originState: model => ({
      sides: model === 'a' ? new pc.Vec3(1, -1, 0) : new pc.Vec3(-1, 0, 1),
      worldToOrigin: new pc.Mat4().setTranslate(model === 'a' ? 3 : -7, model === 'a' ? 5 : 11, model === 'a' ? -2 : 13),
    }),
  });
  return { controller, state, boxes, pointCalls, gaussianCalls };
}

test('applies all six independent axis boundaries without crossing model state', () => {
  const fixture = setup();
  fixture.state.controlMode = 'independent';
  fixture.state.independentModes.a = 'axis';
  fixture.state.independentModes.b = 'axis';
  fixture.controller.sync(true);

  assert.equal(fixture.controller.visiblePoint('a', new pc.Vec3(0, 0, 0)), true);
  for (const point of [
    [-1.01, 0, 0], [1.01, 0, 0], [0, -1.01, 0],
    [0, 1.01, 0], [0, 0, -1.01], [0, 0, 1.01],
  ] as const) assert.equal(fixture.controller.visiblePoint('a', new pc.Vec3(...point)), false);
  assert.equal(fixture.controller.visiblePoint('b', new pc.Vec3(5, 0, 0)), true);
  assert.equal(fixture.controller.visiblePoint('a', new pc.Vec3(5, 0, 0)), false);
  assert.equal(fixture.pointCalls.length, 2);
  assert.equal(fixture.gaussianCalls.length, 2);
  assert.equal(fixture.gaussianCalls.every(call => call.at(-1) === true), true);
});

test('tests rotated box clipping in box-local coordinates', () => {
  const fixture = setup();
  fixture.state.controlMode = 'independent';
  fixture.state.independentModes.a = 'box';
  fixture.boxes.a.setPosition(10, -3, 4);
  fixture.boxes.a.setEulerAngles(20, -35, 70);
  fixture.boxes.a.setLocalScale(2, 4, 6);
  fixture.controller.sync();

  const transform = fixture.boxes.a.getWorldTransform();
  const inside = transform.transformPoint(new pc.Vec3(0.49, -0.49, 0.49));
  const outside = transform.transformPoint(new pc.Vec3(0.51, 0, 0));
  assert.equal(fixture.controller.visiblePoint('a', inside), true);
  assert.equal(fixture.controller.visiblePoint('a', outside), false);
  assert.equal(fixture.controller.visiblePoint('b', outside), true, 'disabled B box does not clip B');
  const gaussianA = fixture.gaussianCalls[0];
  assert.equal(gaussianA[0], 'a');
  assert.equal(gaussianA[1], true);
  assert.equal(gaussianA[4], true);
  assert.deepEqual(Array.from((gaussianA[5] as pc.Mat4).data), Array.from(new pc.Mat4().invert(transform).data));
  assert.deepEqual((gaussianA[6] as pc.Vec3).toArray(), [1, -1, 0]);
  assert.deepEqual(Array.from((gaussianA[7] as pc.Mat4).data), Array.from(new pc.Mat4().setTranslate(3, 5, -2).data));
});
