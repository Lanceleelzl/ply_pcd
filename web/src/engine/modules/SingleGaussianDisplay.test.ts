import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as pc from 'playcanvas';
import { SingleGaussianDisplay } from './SingleGaussianDisplay.ts';

function fixture() {
  const assets: pc.Asset[] = [];
  const removed: pc.Asset[] = [];
  const visibility: boolean[] = [];
  const parent = new pc.Entity('Single model');
  const app = { assets: {
    add: (asset: pc.Asset) => {
      asset.registry = Object.assign(new pc.EventHandler(), { _loader: { clearCache: () => {} } }) as unknown as pc.AssetRegistry;
      assets.push(asset);
    },
    load: () => {}, remove: (asset: pc.Asset) => removed.push(asset),
  } } as unknown as pc.Application;
  const display = new SingleGaussianDisplay(app, parent, [0, 0, 0], visible => visibility.push(visible));
  return { display, assets, removed, visibility, parent };
}

test('failed single-model Gaussian loads leave no registered assets', async () => {
  const f = fixture();
  const pending = f.display.show('/broken.ply', 'broken.ply');
  f.assets[0].fire('error', new Error('broken PLY'));
  await assert.rejects(pending, /broken PLY/);
  assert.deepEqual(f.removed, f.assets);
  assert.equal(f.parent.children.length, 0);
  assert.equal(f.visibility.at(-1), true);
});

test('late single-model Gaussian completion after destruction releases the asset without reviving points', async () => {
  const f = fixture();
  const pending = f.display.show('/slow.ply', 'slow.ply');
  const asset = f.assets[0];
  f.display.destroy();
  const visibilityCount = f.visibility.length;
  let destroyed = 0;
  asset.resource = { destroy: () => { destroyed++; } };
  asset.loaded = true;
  asset.fire('load', asset);
  await pending;
  assert.deepEqual(f.removed, f.assets);
  assert.equal(destroyed, 1);
  assert.equal(f.parent.children.length, 0);
  assert.equal(f.visibility.length, visibilityCount);
});
