import assert from 'node:assert/strict';
import test from 'node:test';
import { multiplyQuaternions, parseRegistrationMatrix, registrationComponents } from './registration-matrix.ts';

test('parse registration business matrix and decompose similarity', () => {
  const matrix = parseRegistrationMatrix('0 -2 0 5\n2 0 0 7\n0 0 2 0\n0 0 0 1');
  const result = registrationComponents(matrix);
  assert.equal(result.scale, 2);
  assert.deepEqual(result.translation, [5, 7, 0]);
  assert.ok(Math.abs(result.rotation[0] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(result.rotation[3] - Math.SQRT1_2) < 1e-12);
  assert.deepEqual(multiplyQuaternions([1, 0, 0, 0], result.rotation), result.rotation);
});

test('reject shear, reflection, non-finite and incomplete matrix', () => {
  for (const input of [
    '1 0.2 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1',
    '-1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1',
    '1 0 0 NaN\n0 1 0 0\n0 0 1 0\n0 0 0 1',
    '1 0 0 0',
  ]) assert.throws(() => parseRegistrationMatrix(input));
});

test('decompose a half-turn without losing the rotation axis', () => {
  const result = registrationComponents(parseRegistrationMatrix('-1 0 0 0\n0 -1 0 0\n0 0 1 0\n0 0 0 1'));
  assert.ok(Math.abs(result.rotation[0]) < 1e-12);
  assert.ok(Math.abs(result.rotation[3]) === 1);
});
