import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinateQueryViews } from './coordinate-query-views.ts';

test('exports a coordinated query view factory', () => {
  assert.equal(typeof createCoordinateQueryViews, 'function');
});
