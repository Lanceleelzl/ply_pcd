import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveMovingModel, fixedModel, roleSummary } from './registration-role-state.ts';

test('resolves moving and fixed roles', () => {
  assert.equal(effectiveMovingModel('auto', 'b'), 'b');
  assert.equal(fixedModel('a'), 'b');
  assert.equal(roleSummary('b'), '移动 B（黄色）　固定 A（灰色）');
});
