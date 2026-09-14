import assert from 'node:assert/strict';
import test from 'node:test';
import { createGaussianViewState } from './gaussian-view-state.ts';

test('creates independent Gaussian display state for both models', () => {
  const first = createGaussianViewState();
  const second = createGaussianViewState();
  first.models.a.active = true;
  assert.equal(first.models.a.active, true);
  assert.equal(first.models.b.active, false);
  assert.equal(second.models.a.active, false);
  assert.equal(first.error, false);
});
