import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as pc from 'playcanvas';
import { SingleModelScene } from './SingleModelScene.ts';
import { transformParametersMatrix, transformXYZ, type TransformParameters, type XYZ } from '../../coordinate-math.ts';

const identity = (): TransformParameters => ({ translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] });

function fixture(origin: XYZ = [1_000_000.125, 2_000_000.25, 3_000_000.375], transform = identity()) {
  const canvas = { id: 'single-model-scene-test', width: 640, height: 480 } as HTMLCanvasElement;
  const app = new pc.AppBase(canvas);
  const options = new pc.AppOptions();
  options.graphicsDevice = new pc.NullGraphicsDevice(canvas);
  options.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem];
  app.init(options);
  const cloud = { positions: new Float32Array([0, 0, 2, 0, 0, 4]), count: 2,
    min: new pc.Vec3(0, 0, 2), max: new pc.Vec3(0, 0, 4) };
  const scene = new SingleModelScene(app as pc.Application, cloud, origin, transform);
  return { app, scene, cloud };
}

test('single-model transform edits keep the double-precision display origin and update bounds', () => {
  const f = fixture();
  const anchor = [...f.scene.displayOrigin];
  const changed = { ...identity(), translation: [12.25, -4.5, 2.125] as XYZ };
  try {
    f.scene.applyTransform(changed);
    assert.deepEqual(f.scene.displayOrigin, anchor);
    assert.deepEqual(f.scene.root.getLocalPosition().toArray(), changed.translation);
    assert.deepEqual(f.scene.bounds().min.toArray(), [12.25, -4.5, 4.125]);
    assert.deepEqual(f.scene.bounds().max.toArray(), [12.25, -4.5, 6.125]);
  } finally { f.scene.destroy(); }
});

test('single-model rotation and scale updates retain the original display frame', () => {
  const f = fixture([128.125, 256.25, 32.375]);
  const anchor = [...f.scene.displayOrigin];
  const changed: TransformParameters = { translation: [12, -3, 7], rotation_degrees: [12, -23, 34], scale: [2, 3, 4] };
  try {
    f.scene.applyTransform(changed);
    const expected = transformXYZ(transformParametersMatrix(changed), [128.125, 256.25, 34.375])
      .map((value, index) => value - anchor[index]);
    const actual = f.scene.root.getWorldTransform().transformPoint(new pc.Vec3(0, 0, 2));
    assert.ok(actual.distance(new pc.Vec3(...expected)) < 1e-4);
    assert.deepEqual(f.scene.displayOrigin, anchor);
  } finally { f.scene.destroy(); }
});

test('single-model origin planes use the file origin rather than the localized preview origin', () => {
  const f = fixture([100, 200, 300]);
  try {
    const plane = f.scene.root.findByName('XOY origin plane')!;
    assert.deepEqual(plane.getPosition().toArray(), [-100, -200, -300]);
    assert.deepEqual(f.scene.worldToOrigin().transformPoint(new pc.Vec3(0, 0, 2)).toArray(), [100, 200, 302]);
  } finally { f.scene.destroy(); }
});
