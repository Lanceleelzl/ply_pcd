import assert from 'node:assert/strict';
import test from 'node:test';
import * as pc from 'playcanvas';
import { DesktopApplication } from './DesktopApplication.ts';

test('desktop initialization omits XR while forwarding rendering and input options', t => {
  const options = new pc.AppOptions();
  options.xr = pc.XrManager;
  const keyboard = Object.create(pc.Keyboard.prototype) as pc.Keyboard;
  const mouse = Object.create(pc.Mouse.prototype) as pc.Mouse;
  const device = Object.create(pc.WebglGraphicsDevice.prototype) as pc.WebglGraphicsDevice;
  options.keyboard = keyboard; options.mouse = mouse; options.graphicsDevice = device;
  options.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
  options.resourceHandlers = [pc.GSplatHandler, pc.TextureHandler];
  const seen: pc.AppOptions[] = [];
  t.mock.method(pc.AppBase.prototype, 'init', (value: pc.AppOptions) => { seen.push(value); });
  const application = Object.create(DesktopApplication.prototype) as DesktopApplication;
  application.init(options);
  assert.equal(options.xr, undefined);
  assert.deepEqual(seen, [options]);
  assert.equal(options.keyboard, keyboard);
  assert.equal(options.mouse, mouse);
  assert.equal(options.graphicsDevice, device);
  assert.deepEqual(options.componentSystems, [pc.CameraComponentSystem, pc.GSplatComponentSystem]);
  assert.deepEqual(options.resourceHandlers, [pc.GSplatHandler, pc.TextureHandler]);
});

test('desktop initialization leaves browser XR globals unchanged', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.mock.method(pc.AppBase.prototype, 'init', () => {});
  const application = Object.create(DesktopApplication.prototype) as DesktopApplication;
  application.init(new pc.AppOptions());
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'navigator'), before);
});
