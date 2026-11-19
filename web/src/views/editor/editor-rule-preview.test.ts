import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorRule } from '../../api/gaussian-editor-api';
import { containsEditorRule, keepsEditorPoint, polygonValidationError, rectangleFromCorners } from './editor-rule-preview.ts';

test('two opposite corners create a valid axis-aligned polygon', () => {
  const points = rectangleFromCorners([4, 5], [1, 2]);
  assert.deepEqual(points, [[1, 2], [4, 2], [4, 5], [1, 5]]);
  assert.equal(polygonValidationError(points!), null);
  assert.equal(rectangleFromCorners([1, 2], [1, 5]), null);
});

test('polygon validation rejects zero area and crossing edges before saving', () => {
  assert.equal(polygonValidationError([[0, 0], [1, 1], [2, 2]]), '平面边界面积为零');
  assert.equal(polygonValidationError([[0, 0], [4, 4], [0, 4], [4, 0], [5, -2]]), '平面边界不能自相交');
  assert.equal(polygonValidationError([[0, 0], [4, 0], [4, 4], [0, 4]]), null);
});

test('polygon includes its edges and applies across the full height', () => {
  const polygon: EditorRule = { type: 'polygon', action: 'keep', points: [[0, 0], [4, 0], [4, 4], [0, 4]] };
  assert.equal(containsEditorRule(polygon, [2, 0, 100]), true);
  assert.equal(containsEditorRule(polygon, [4, 4, -100]), true);
  assert.equal(containsEditorRule(polygon, [4.1, 2, 0]), false);
});

test('small polygons at large projected coordinates remain valid in both windings', () => {
  const points: [number, number][] = [[500000, 3000000], [500000.001, 3000000],
    [500000.001, 3000000.001], [500000, 3000000.001]];
  for (const winding of [points, points.toReversed()]) {
    assert.equal(polygonValidationError(winding), null);
    const rule: EditorRule = { type: 'polygon', action: 'keep', points: winding };
    assert.equal(containsEditorRule(rule, [500000.0005, 3000000.0005, 100]), true);
    assert.equal(containsEditorRule(rule, [500000.002, 3000000.0005, 0]), false);
  }
});

test('polygon validation rejects repeated vertices, edge touches and overlapping edges', () => {
  const cases: [number, number][][] = [
    [[0, 0], [4, 0], [4, 0], [4, 4], [0, 4]],
    [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
    [[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]],
    [[0, 0], [4, 0], [2, 0], [4, 4], [0, 4]],
    [[0, 0], [4, 0], [4, 4], [1, 4], [1, 0], [3, 0], [3, 2], [0, 2]],
  ];
  for (const points of cases) assert.notEqual(polygonValidationError(points), null);
});

test('polygon validation allows collinear inserted vertices and concave polygons', () => {
  assert.equal(polygonValidationError([[0, 0], [2, 0], [4, 0], [4, 4], [0, 4]]), null);
  assert.equal(polygonValidationError([[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]]), null);
});

test('keep rules form a union before remove rules are subtracted', () => {
  const rules: EditorRule[] = [
    { type: 'sphere', action: 'keep', center: [0, 0, 0], radius: 2 },
    { type: 'sphere', action: 'keep', center: [10, 0, 0], radius: 2 },
    { type: 'sphere', action: 'remove', center: [0, 0, 0], radius: 1 },
  ];
  assert.equal(keepsEditorPoint(rules, [1.5, 0, 0]), true);
  assert.equal(keepsEditorPoint(rules, [10, 0, 0]), true);
  assert.equal(keepsEditorPoint(rules, [0, 0, 0]), false);
  assert.equal(keepsEditorPoint(rules, [5, 0, 0]), false);
  assert.equal(keepsEditorPoint(rules.slice(2), [5, 0, 0]), true);
});

test('rotated box checks the inverse quaternion and each local half-size', () => {
  const half = Math.SQRT1_2;
  const box: EditorRule = { type: 'box', action: 'keep', center: [1, 2, 3], size: [4, 2, 2],
    rotation: [half, 0, 0, half] };
  assert.equal(containsEditorRule(box, [1, 3.9, 3]), true);
  assert.equal(containsEditorRule(box, [2.1, 4, 3]), false);
  assert.equal(containsEditorRule(box, [1, 4.1, 3]), false);
});

test('rotated box surfaces are included without admitting genuine outside points', () => {
  for (const scale of [1e-6, 1, 1e6]) {
    const box: EditorRule = { type: 'box', action: 'keep', center: [0, 0, 0],
      size: [2 * scale, scale, scale], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] };
    for (const point of [[0, 1, 0], [0.5, 0, 0], [0, 0, 0.5], [0.5, 1, 0.5]])
      assert.equal(containsEditorRule(box, point.map(value => value * scale) as [number, number, number]), true);
    for (const point of [[0, 1 + 1e-10, 0], [0.5 + 1e-10, 0, 0], [0, 0, 0.5 + 1e-10]])
      assert.equal(containsEditorRule(box, point.map(value => value * scale) as [number, number, number]), false);
  }
});

test('removing a rotated box also removes centers on its surface', () => {
  const box: EditorRule = { type: 'box', action: 'remove', center: [0, 0, 0],
    size: [2, 1, 1], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] };
  assert.equal(keepsEditorPoint([box], [0, 1, 0]), false);
});
