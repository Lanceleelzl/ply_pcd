import assert from 'node:assert/strict';
import test from 'node:test';
import { isIndependentBoxHelperVisible, isJointBoxHelperVisible } from './clipping-helper-state.ts';

test('checks helper visibility for joint and independent box modes', () => {
  assert.equal(isJointBoxHelperVisible('joint', 'box', true), true);
  assert.equal(isJointBoxHelperVisible('joint', 'axis', true), false);
  assert.equal(isIndependentBoxHelperVisible('independent', 'b', { a: 'off', b: 'box' }, { a: true, b: true }), true);
  assert.equal(isIndependentBoxHelperVisible('joint', 'b', { a: 'off', b: 'box' }, { a: true, b: true }), false);
});
