import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { geographicDirections, projectedToFile, wgs84Utm } from './geographic-frame.ts';
import * as pc from 'playcanvas';
import { ViewportCameraController, type CameraOrientation } from '../../engine/core/ViewportCameraController.ts';

test('view rotation derives geographic directions without translation or scale magnitude', () => {
  const directions = geographicDirections({ translation: [100, 200, 300], rotation_degrees: [0, 0, 180], scale: [2, 3, 4] }, [1, 2, 3]);
  const expected = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];
  directions.forEach((vector, index) => vector.forEach((value, axis) => assert.ok(Math.abs(value - expected[index][axis]) < 1e-10)));
});

test('Y up source mapping supplies physical north and up to the camera', () => {
  const directions = geographicDirections({ translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] }, [1, -3, 2]);
  const expected = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  directions.forEach((vector, index) => vector.forEach((value, axis) => assert.ok(Math.abs(value - expected[index][axis]) < 1e-10)));
});

test('UTM suggestion handles hemispheres, longitude boundaries and special zones', () => {
  assert.equal(wgs84Utm(120.5, 30), 32651);
  assert.equal(wgs84Utm(120.5, -30), 32751);
  assert.equal(wgs84Utm(180, 0), 32660);
  assert.equal(wgs84Utm(5, 60), 32632);
  assert.equal(wgs84Utm(10, 75), 32633);
});

test('inverse projection restores signed file axes, source units and nonzero reference', () => {
  assert.deepEqual(projectedToFile([1100, 2200, 53], [1000, 2000, 50], [10, 20, 30], [1, -3, 2], .01, [.3048, .3048]), [3058, 320, -6066]);
});

test('north view keeps east screen-right and north screen-up after two model rotations', () => {
  const [east, north, up] = geographicDirections({ translation: [0, 0, 0], rotation_degrees: [90, 0, 180], scale: [1, 1, 1] }, [1, 2, 3]);
  let orientation: CameraOrientation | undefined;
  const entity = { camera: { orthoHeight: 1 }, setPosition() {}, lookAt() {} } as unknown as pc.Entity;
  const controller = new ViewportCameraController({ camera: entity, canvas: {} as HTMLCanvasElement,
    orientationChanged: value => { orientation = value; }, baseDiagonal: 1,
    getBounds: () => ({ min: new pc.Vec3(0, 0, 0), max: new pc.Vec3(1, 1, 1) }) });
  controller.setViewDirection(new pc.Vec3(...up), new pc.Vec3(...north));
  assert.ok(new pc.Vec3(orientation!.right.x, orientation!.right.y, orientation!.right.z).dot(new pc.Vec3(...east)) > .999999);
  assert.ok(new pc.Vec3(orientation!.cubeUp.x, orientation!.cubeUp.y, orientation!.cubeUp.z).dot(new pc.Vec3(...north)) > .999999);
});
