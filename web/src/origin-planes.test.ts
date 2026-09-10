import { strict as assert } from 'node:assert';
import * as pc from 'playcanvas';
import { OriginPlaneController } from './origin-planes.ts';
import { createOriginPlaneState } from './origin-plane-state.ts';

// Use real PlayCanvas entities and render components without a browser or GPU.
const canvas = { id: 'origin-plane-test', width: 640, height: 480 } as HTMLCanvasElement;
const app = new pc.AppBase(canvas);
const options = new pc.AppOptions();
options.graphicsDevice = new pc.NullGraphicsDevice(canvas);
options.componentSystems = [pc.RenderComponentSystem];
app.init(options);
const entities = { a: new pc.Entity('A'), b: new pc.Entity('B') };
app.root.addChild(entities.a); app.root.addChild(entities.b);
const state = createOriginPlaneState();
const visible = { a: true, b: true };
const controller = new OriginPlaneController(app as pc.Application, entities,
  { a: [1000, 2000, 30], b: [-10, 20, 5] }, { a: 100, b: 50 }, visible, state);
try {
  const frameA = entities.a.findByName('A origin frame')!;
  const point = (x: number, y: number, z: number) => frameA.getWorldTransform().transformPoint(new pc.Vec3(x, y, z));
  for (const [plane, axis] of [['yoz', 0], ['xoz', 1], ['xoy', 2]] as const) {
    for (const side of [-1, 1]) {
      state.a[plane].side = side;
      const kept = [0, 0, 0]; kept[axis] = side * 2;
      const removed = kept.map(value => -value);
      assert.equal(controller.visiblePoint('a', point(...kept as [number, number, number])), true);
      assert.equal(controller.visiblePoint('a', point(...removed as [number, number, number])), false);
      assert.equal(controller.visiblePoint('a', point(0, 0, 0)), true, 'boundary is retained');
      assert.equal(controller.visiblePoint('b', point(...removed as [number, number, number])), true, 'B remains unclipped');
      state.a[plane].side = 0;
    }
  }
  entities.a.setLocalPosition(12, -4, 8);
  entities.a.setLocalEulerAngles(25, -30, 70);
  entities.a.setLocalScale(2, 3, 0.5);
  state.a.yoz.side = 1; state.a.xoz.side = -1; state.a.xoy.side = 1;
  assert.equal(controller.visiblePoint('a', point(2, -3, 4)), true);
  for (const coordinates of [[-2, -3, 4], [2, 3, 4], [2, -3, -4]] as const) {
    assert.equal(controller.visiblePoint('a', point(coordinates[0], coordinates[1], coordinates[2])), false, 'planes intersect in model coordinates');
  }
  state.a.xoy.visible = true;
  app.fire('update');
  const visual = frameA.findByName('A XOY origin plane')!;
  assert.equal(visual.enabled, true);
  visible.a = false; app.fire('update');
  assert.equal(visual.enabled, false);
  visible.a = true; app.fire('update');
  assert.equal(visual.enabled, true, 'model visibility preserves plane choice');
  Object.assign(state, createOriginPlaneState()); app.fire('update');
  assert.equal(visual.enabled, false);
  assert.equal(controller.visiblePoint('a', point(-2, 3, -4)), true, 'clear removes clipping');
} finally {
  controller.destroy();
}
assert.equal(entities.a.children.length, 0);
assert.equal(entities.b.children.length, 0);
assert.equal(app.hasEvent('update'), false, 'destroy removes update listener');
console.log('Origin planes: six half-spaces, boundaries, model isolation, transformed intersection, visibility, clear and teardown passed');
