import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorGeography } from '../../api/gaussian-editor-api';
import { projectedOriginForPoint } from './editor-geography.ts';

const frame: EditorGeography = { source_epsg: 32651, reference: [10, 20, 30],
  projected_origin: [0, 0, 50], axes: [1, -3, 2], metres_per_unit: 0.01 };

test('selected scene point becomes the supplied projected coordinate', () => {
  assert.deepEqual(projectedOriginForPoint([110, 220, 330], frame,
    [500000, 3000000], [1, 1]), [499999, 3000003]);
});

test('projected coordinate unit conversion is applied to both axes', () => {
  const factor = 1200 / 3937;
  const result = projectedOriginForPoint([110, 220, 330], frame, [500000, 3000000], [factor, factor]);
  assert.ok(Math.abs(result[0] - (500000 - 1 / factor)) < 1e-9);
  assert.ok(Math.abs(result[1] - (3000000 + 3 / factor)) < 1e-9);
});

test('duplicate axes and invalid projected units are rejected', () => {
  assert.throws(() => projectedOriginForPoint([110, 220, 330], { ...frame, axes: [1, -1, 3] },
    [500000, 3000000], [1, 1]));
  assert.throws(() => projectedOriginForPoint([110, 220, 330], frame,
    [500000, 3000000], [1, 0]));
});
