import assert from 'node:assert/strict';
import test from 'node:test';
import { clippingHandleMode, isClippingInteractionActive } from './clipping-interaction-state.ts';

test('gates clipping handles by panel and query state', () => {
  assert.equal(isClippingInteractionActive(true, 'axis'), true);
  assert.equal(isClippingInteractionActive(false, 'axis'), false);
  assert.equal(clippingHandleMode(true, false, 'box'), 'off');
  assert.equal(clippingHandleMode(true, true, 'box'), 'box');
});
