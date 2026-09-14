import assert from 'node:assert/strict';
import test from 'node:test';
import { isClippingEnabled } from './clipping-enabled.ts';

test('checks joint and independent clipping activation', () => {
  assert.equal(isClippingEnabled('joint', 'off', { a: 'off', b: 'off' }), false);
  assert.equal(isClippingEnabled('joint', 'axis', { a: 'off', b: 'off' }), true);
  assert.equal(isClippingEnabled('independent', 'off', { a: 'off', b: 'box' }), true);
});
