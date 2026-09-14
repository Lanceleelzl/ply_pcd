import assert from 'node:assert/strict';
import test from 'node:test';
import * as pc from 'playcanvas';
import { GaussianClipController } from './gaussian-clipping.ts';

test('forwards axis, rotated box and origin-plane parameters to the Gaussian work buffer', context => {
  let now = 100;
  context.mock.method(performance, 'now', () => now);
  const modifiers: Array<{ glsl: string; wgsl: string }> = [];
  const parameters: Array<[string, unknown]> = [];
  const component = {
    setWorkBufferModifier: (modifier: { glsl: string; wgsl: string }) => modifiers.push(modifier),
    setParameter: (name: string, value: unknown) => parameters.push([name, value]),
  } as unknown as pc.GSplatComponent;
  const controller = new GaussianClipController(component);
  const min = new pc.Vec3(-1, -2, -3);
  const max = new pc.Vec3(4, 5, 6);
  const box = new pc.Mat4().setTRS(new pc.Vec3(7, 8, 9), new pc.Quat().setFromEulerAngles(10, 20, 30), new pc.Vec3(2, 4, 6));
  const worldToBox = new pc.Mat4().invert(box);
  const originSides = new pc.Vec3(1, -1, 1);
  const origin = new pc.Mat4().setTRS(new pc.Vec3(-4, 3, 2), new pc.Quat().setFromEulerAngles(-15, 25, 5), pc.Vec3.ONE);
  const worldToOrigin = new pc.Mat4().invert(origin);

  assert.equal(controller.setClipState(true, min, max, true, worldToBox, originSides, worldToOrigin), true);
  assert.equal(modifiers.length, 1, 'the work-buffer shader is installed once');
  assert.match(modifiers[0].glsl, /uClipWorldToBox/);
  assert.match(modifiers[0].wgsl, /uClipWorldToOrigin/);
  assert.deepEqual(parameters.map(([name]) => name), [
    'uClipEnabled', 'uClipMin', 'uClipMax', 'uClipBoxEnabled',
    'uClipWorldToBox', 'uOriginClipSides', 'uClipWorldToOrigin',
  ]);
  assert.equal(parameters[0][1], 1);
  assert.deepEqual(Array.from(parameters[1][1] as Float32Array), [-1, -2, -3]);
  assert.deepEqual(Array.from(parameters[2][1] as Float32Array), [4, 5, 6]);
  assert.equal(parameters[3][1], 1);
  assert.deepEqual(Array.from(parameters[4][1] as Float32Array), Array.from(worldToBox.data));
  assert.deepEqual(Array.from(parameters[5][1] as Float32Array), [1, -1, 1]);
  assert.deepEqual(Array.from(parameters[6][1] as Float32Array), Array.from(worldToOrigin.data));

  assert.equal(controller.setClipState(true, min, max, true, worldToBox, originSides, worldToOrigin), false);
  assert.equal(parameters.length, 7, 'unchanged state does not rebuild the work buffer');

  now = 120;
  assert.equal(controller.setClipState(true, new pc.Vec3(-2, -2, -3), max, true, worldToBox, originSides, worldToOrigin), false);
  assert.equal(parameters.length, 7, 'drag updates inside the throttle interval are deferred');

  assert.equal(controller.setClipState(true, new pc.Vec3(-2, -2, -3), max, true, worldToBox, originSides, worldToOrigin, true), true);
  assert.equal(parameters.length, 14, 'the final forced update bypasses throttling');
  assert.deepEqual(Array.from(parameters[8][1] as Float32Array), [-2, -2, -3]);
});
