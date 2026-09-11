import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as pc from 'playcanvas';
import { RegistrationScene } from './RegistrationScene.ts';
import type { PreviewCloud } from '../../point-cloud';

test('scene bounds include transformed model corners and teardown removes its hierarchy', context => {
  const canvas = { id: 'registration-scene-test', width: 640, height: 480 } as HTMLCanvasElement;
  const app = new pc.AppBase(canvas);
  const options = new pc.AppOptions();
  options.graphicsDevice = new pc.NullGraphicsDevice(canvas);
  options.componentSystems = [pc.RenderComponentSystem];
  app.init(options);
  const cloud: PreviewCloud = {
    positions: new Float32Array([0, 0, 0, 1, 2, 3]), count: 2,
    min: new pc.Vec3(0, 0, 0), max: new pc.Vec3(1, 2, 3),
  };
  const scene = new RegistrationScene(app as pc.Application, { a: cloud, b: cloud },
    { a: [1000000, 2000000, 0], b: [1000000, 2000000, 0] }, {
      a: { translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] },
      b: { translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] },
    }, 'b');
  const material = scene.pointMaterials.a;
  const destroy = context.mock.method(material, 'destroy');
  try {
    assert.deepEqual(scene.bounds().min.toArray(), [0, 0, 0]);
    assert.deepEqual(scene.bounds().max.toArray(), [1, 2, 3]);
    scene.display.setPose([10, -3, 2], [0, 0, 90]);
    const bounds = scene.bounds();
    assert.ok(bounds.min.distance(new pc.Vec3(0, -3, 0)) < 1e-8);
    assert.ok(bounds.max.distance(new pc.Vec3(10, 2, 5)) < 1e-8);
    assert.equal(scene.clipBox.enabled, false);
    assert.equal(scene.independentClipBoxes.a.enabled, false);
    assert.equal(scene.independentClipBoxes.b.enabled, false);
    assert.equal(app.root.children.length, 1);
  } finally {
    scene.destroy();
  }
  assert.equal(app.root.children.length, 0);
  assert.equal(destroy.mock.callCount(), 1);
  scene.destroy();
  assert.equal(destroy.mock.callCount(), 1);
});
