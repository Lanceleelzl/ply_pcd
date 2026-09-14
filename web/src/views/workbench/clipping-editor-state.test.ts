import assert from 'node:assert/strict';
import test from 'node:test';
import { editedClippingMode, editedClippingModel } from './clipping-editor-state.ts';

test('resolves joint and independent clipping editor state', () => {
  assert.equal(editedClippingMode('joint', 'box', 'a', { a: 'off', b: 'axis' }), 'box');
  assert.equal(editedClippingMode('independent', 'off', 'b', { a: 'off', b: 'axis' }), 'axis');
  assert.equal(editedClippingModel('joint', 'b'), 'joint');
  assert.equal(editedClippingModel('independent', 'b'), 'b');
});
