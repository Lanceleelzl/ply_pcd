import assert from 'node:assert/strict';
import test from 'node:test';
import type { EditorRule } from '../../api/gaussian-editor-api';
import { containsEditorRule, keepsEditorPoint } from './editor-rule-preview.ts';

test('polygon includes its edges and applies across the full height', () => {
  const polygon: EditorRule = { type: 'polygon', action: 'keep', points: [[0, 0], [4, 0], [4, 4], [0, 4]] };
  assert.equal(containsEditorRule(polygon, [2, 0, 100]), true);
  assert.equal(containsEditorRule(polygon, [4, 4, -100]), true);
  assert.equal(containsEditorRule(polygon, [4.1, 2, 0]), false);
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
