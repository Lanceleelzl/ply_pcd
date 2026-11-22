import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sceneOffset } from './viewer-origin.ts';

test('local projected coordinates retain centimetre differences', () => {
  const delta = sceneOffset({ epsg:32650,offset:[788279.625,3152314.25,64.3] },
    { epsg:32650,offset:[788279.6,3152314.2,64.2] });
  for (const [i,v] of [0.025,0.05,0.1].entries()) assert.ok(Math.abs(delta[i]-v)<1e-6);
});
test('WGS84 and UTM coordinates align at the zone central meridian', () => {
  const delta = sceneOffset({ epsg:4326,offset:[117,0,12] },{ epsg:32650,offset:[500000,0,10] });
  assert.ok(Math.abs(delta[0])<1e-5 && Math.abs(delta[1])<1e-5);
  assert.equal(delta[2],2);
});
test('unknown coordinate systems do not produce a guessed translation', () => {
  assert.throws(() => sceneOffset({epsg:999999,offset:[0,0,0]},{epsg:32650,offset:[0,0,0]}));
});
