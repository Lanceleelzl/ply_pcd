import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMatrix } from './matrix-display.ts';

test('formats matrices with stable row layout and precision', () => {
  assert.equal(formatMatrix([[1, 0], [1.23456, 2]], 3), '1.000 0.000\n1.235 2.000');
});
