import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleWorkbenchModelVisible } from './model-visibility.ts';

test('toggles entity visibility and refreshes tools', () => {
  const states = { a: true, b: false };
  const entityA = { enabled: true };
  const entities = { a: entityA, b: { enabled: false } } as never;
  let refreshed = 0;
  assert.equal(toggleWorkbenchModelVisible('a', states, entities, () => { refreshed += 1; }), false);
  assert.equal(states.a, false);
  assert.equal(entityA.enabled, false);
  assert.equal(refreshed, 1);
});
