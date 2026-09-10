import { strict as assert } from 'node:assert';
import { InputController } from './InputController.ts';
import type { ViewportCameraController } from './ViewportCameraController';

// Exercise event consumption separately from camera suppression without a GPU.
const windowEvents = new EventTarget();
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: windowEvents });
const canvas = Object.assign(new EventTarget(), { style: { cursor: '' } });
const orbit: number[][] = [];
const pan: number[][] = [];
const zoom: number[] = [];
let consume = false;
let blockNavigation = false;
let blockDrag = false;
let releases = 0;
const controller = new InputController(canvas as unknown as HTMLCanvasElement, {
  orbitByPixels: (x: number, y: number) => orbit.push([x, y]),
  panByPixels: (x: number, y: number) => pan.push([x, y]),
  zoom: (delta: number) => zoom.push(delta),
} as unknown as ViewportCameraController, {
  pointerDown: () => consume,
  navigationBlocked: () => blockNavigation,
  dragBlocked: () => blockDrag,
  pointerUp: () => { releases++; },
});
let handlePresses = 0;
canvas.addEventListener('pointerdown', () => { handlePresses++; });
const send = (target: EventTarget, type: string, values: Record<string, number> = {}) => {
  const event = Object.assign(new Event(type, { cancelable: true }), { button: 0, clientX: 10, clientY: 20 }, values);
  target.dispatchEvent(event);
  return event;
};
try {
  blockNavigation = true;
  const handleDown = send(canvas, 'pointerdown');
  send(windowEvents, 'pointermove', { clientX: 30, clientY: 40 });
  assert.equal(handlePresses, 1, 'camera suppression must preserve the handle listener');
  assert.equal(handleDown.defaultPrevented, false);
  assert.deepEqual(orbit, []);
  send(windowEvents, 'pointerup');

  consume = true; blockNavigation = false;
  assert.equal(send(canvas, 'pointerdown').defaultPrevented, true);
  assert.equal(handlePresses, 1, 'consumed picking must not start a handle');
  send(windowEvents, 'pointermove', { clientX: 30, clientY: 40 });
  assert.deepEqual(orbit, []);
  send(windowEvents, 'pointerup');

  consume = false;
  send(canvas, 'pointerdown');
  send(windowEvents, 'pointermove', { clientX: 15, clientY: 23 });
  assert.deepEqual(orbit, [[5, 3]]);
  blockDrag = true;
  send(windowEvents, 'pointermove', { clientX: 19, clientY: 28 });
  assert.equal(orbit.length, 1, 'active handle drag suppresses camera motion');
  send(windowEvents, 'pointerup');
  blockDrag = false;
  send(windowEvents, 'pointermove', { clientX: 40, clientY: 50 });
  assert.equal(orbit.length, 1, 'release ends navigation');

  send(canvas, 'pointerdown', { button: 1 });
  send(windowEvents, 'pointermove', { clientX: 17, clientY: 29 });
  assert.deepEqual(pan, [[7, 9]]);
  send(windowEvents, 'pointerup');
  assert.equal(send(canvas, 'wheel', { deltaY: 120 }).defaultPrevented, true);
  assert.deepEqual(zoom, [120]);
  assert.equal(releases, 4);

  controller.destroy();
  send(canvas, 'pointerdown');
  send(windowEvents, 'pointermove', { clientX: 50, clientY: 60 });
  send(windowEvents, 'pointerup');
  send(canvas, 'wheel', { deltaY: 240 });
  assert.equal(orbit.length, 1);
  assert.equal(pan.length, 1);
  assert.equal(releases, 4);
  assert.deepEqual(zoom, [120], 'destroy removes input listeners');
} finally {
  controller.destroy();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}
console.log('Input routing: handle propagation, consumed picking, camera controls, drag suppression, release and teardown passed');
