import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as pc from 'playcanvas';
import { GaussianDisplayController } from './GaussianDisplayController.ts';

function fixture() {
  const assets: pc.Asset[] = [];
  const removed: pc.Asset[] = [];
  const states: Array<{ active: boolean; loading: boolean }> = [];
  const messages: string[] = [];
  const entities = { a: { render: { enabled: true } }, b: { render: { enabled: true } } };
  const controller = new GaussianDisplayController({
    app: { assets: {
      add: (asset: pc.Asset) => assets.push(asset),
      load: () => {},
      remove: (asset: pc.Asset) => removed.push(asset),
    } } as unknown as pc.Application,
    entities: entities as unknown as Record<'a' | 'b', pc.Entity>,
    urls: { a: '/a.ply', b: undefined }, origins: { a: [0, 0, 0], b: [0, 0, 0] },
    clippingEnabled: () => false, clipStateChanged: () => {}, presentationChanged: () => {},
    displayChanged: (_model, state) => states.push(state),
    statusChanged: message => messages.push(message),
  });
  return { controller, assets, removed, states, messages, entities };
}

test('Gaussian commands ignore unavailable models and duplicate pending loads', async context => {
  context.mock.method(console, 'error', () => {});
  const f = fixture();
  await f.controller.toggle('b');
  assert.equal(f.assets.length, 0);
  const pending = f.controller.toggle('a');
  await f.controller.toggle('a');
  assert.equal(f.assets.length, 1);
  assert.deepEqual(f.states, [{ active: false, loading: true }]);
  f.assets[0].fire('error', new Error('broken PLY'));
  await pending;
  assert.equal(f.removed.length, 1);
  assert.equal(f.entities.a.render.enabled, true);
  assert.deepEqual(f.states.at(-1), { active: false, loading: false });
  assert.match(f.messages.at(-1)!, /broken PLY/);
  f.controller.destroy();
});

test('late successful loads release their resource without reviving a destroyed scene', async () => {
  const f = fixture();
  const pending = f.controller.toggle('a');
  const asset = f.assets[0];
  asset.registry = Object.assign(new pc.EventHandler(), { _loader: { clearCache: () => {} } }) as unknown as pc.AssetRegistry;
  f.controller.destroy();
  const stateCount = f.states.length;
  Object.defineProperty(f.entities.a, 'render', { get: () => { throw new Error('model already destroyed'); } });
  let released = 0;
  asset.resource = { destroy: () => { released++; } };
  asset.loaded = true;
  asset.fire('load', asset);
  await pending;
  assert.equal(released, 1);
  assert.equal(asset.resources.length, 0);
  assert.equal(f.states.length, stateCount);
  assert.equal(f.messages.length, 0);
  assert.equal(f.removed.length, 1);
});

test('late load errors after destruction do not touch destroyed models or publish UI state', async () => {
  const f = fixture();
  const pending = f.controller.toggle('a');
  f.controller.destroy();
  const stateCount = f.states.length;
  Object.defineProperty(f.entities.a, 'render', { get: () => { throw new Error('model already destroyed'); } });
  f.assets[0].fire('error', new Error('late failure'));
  await pending;
  assert.equal(f.states.length, stateCount);
  assert.equal(f.messages.length, 0);
  assert.equal(f.removed.length, 1);
  assert.doesNotThrow(() => f.controller.destroy());
});
