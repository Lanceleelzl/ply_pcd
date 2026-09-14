import assert from 'node:assert/strict';
import test from 'node:test';
import * as pc from 'playcanvas';
import { pickVisiblePreviewPoint } from './coordinate-query-picking.ts';

test('picks the nearest visible point and respects clipping at the boundary', () => {
  const positions = new Float32Array([
    0, 0, 2,
    0, 0, 4,
    20, 0, 3,
    0, 0, -1,
  ]);
  const visibleDepths: number[] = [];
  const selected = pickVisiblePreviewPoint({
    cloud: { count: 4, positions } as never,
    localToWorld: new pc.Mat4().setTranslate(10, 20, 0),
    cameraPosition: new pc.Vec3(10, 20, 0),
    cameraForward: new pc.Vec3(0, 0, 1),
    nearClip: 0.1,
    screenX: 100,
    screenY: 100,
    radius: 9,
    visiblePoint: world => {
      visibleDepths.push(world.z);
      return world.z >= 4;
    },
    worldToScreen: (world, screen) => { screen.set(100 + world.x - 10, 100 + world.y - 20, world.z); },
  });
  assert.equal(selected, 1, 'the clipped nearer point is skipped and the boundary point is retained');
  assert.deepEqual(visibleDepths, [2, 4, 3, -1]);
  assert.deepEqual(Array.from(positions), [0, 0, 2, 0, 0, 4, 20, 0, 3, 0, 0, -1]);
});

test('returns no hit when visible points are behind the camera or outside the screen radius', () => {
  const selected = pickVisiblePreviewPoint({
    cloud: { count: 2, positions: new Float32Array([0, 0, -2, 15, 0, 3]) } as never,
    localToWorld: new pc.Mat4(),
    cameraPosition: new pc.Vec3(),
    cameraForward: new pc.Vec3(0, 0, 1),
    nearClip: 0.1,
    screenX: 0,
    screenY: 0,
    radius: 9,
    visiblePoint: () => true,
    worldToScreen: (world, screen) => { screen.copy(world); },
  });
  assert.equal(selected, -1);
});
