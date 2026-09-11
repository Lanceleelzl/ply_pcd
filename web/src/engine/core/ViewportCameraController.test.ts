import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as pc from 'playcanvas';
import { ViewportCameraController, type CameraOrientation } from './ViewportCameraController.ts';

test('camera direction, orbit and projection work without view controls or DOM queries', () => {
  const canvas = { id: 'camera-test', width: 640, height: 480, clientWidth: 640, clientHeight: 480 } as HTMLCanvasElement;
  const app = new pc.AppBase(canvas);
  const options = new pc.AppOptions();
  options.graphicsDevice = new pc.NullGraphicsDevice(canvas);
  options.componentSystems = [pc.CameraComponentSystem];
  app.init(options);
  const camera = new pc.Entity('Camera');
  app.root.addChild(camera);
  camera.addComponent('camera');
  const orientations: CameraOrientation[] = [];
  const controller = new ViewportCameraController({
    camera, canvas, baseDiagonal: 10,
    getBounds: () => ({ min: new pc.Vec3(-1, -2, -3), max: new pc.Vec3(1, 2, 3) }),
    orientationChanged: value => orientations.push(structuredClone(value)),
  });
  controller.setViewDirection(new pc.Vec3(1, 0, 0));
  const alongX = camera.getPosition().clone();
  assert.ok(alongX.x > 0);
  assert.equal(alongX.y, 0);
  assert.equal(alongX.z, 0);
  controller.orbit(20, 10);
  assert.ok(camera.getPosition().distance(alongX) > 0.1);
  const orientation = orientations.at(-1)!;
  const right = new pc.Vec3(orientation.right.x, orientation.right.y, orientation.right.z);
  const direction = new pc.Vec3(orientation.direction.x, orientation.direction.y, orientation.direction.z);
  assert.ok(Math.abs(right.dot(direction)) < 1e-10);
  controller.setProjection(true);
  assert.equal(camera.camera!.projection, pc.PROJECTION_ORTHOGRAPHIC);
  const position = camera.getPosition().clone();
  const height = camera.camera!.orthoHeight;
  controller.zoom(100);
  assert.ok(camera.camera!.orthoHeight > height);
  assert.ok(camera.getPosition().equals(position));
  controller.setProjection(false);
  assert.equal(camera.camera!.projection, pc.PROJECTION_PERSPECTIVE);
  controller.zoom(100);
  assert.ok(camera.getPosition().distance(position) > 0.1);
  camera.destroy();
});
