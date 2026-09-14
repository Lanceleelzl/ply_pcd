import assert from 'node:assert/strict';
import test from 'node:test';
import { applyModelRoleColors } from './model-role-presentation.ts';

test('accepts both model entities without DOM dependencies', () => {
  assert.doesNotThrow(() => applyModelRoleColors({ a: {} as never, b: {} as never }, 'a'));
});
