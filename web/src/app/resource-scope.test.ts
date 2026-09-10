import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceScope } from './resource-scope.ts';

test('partial initialization releases acquired resources in reverse order, only once', () => {
  const scope = new ResourceScope();
  const released: string[] = [];
  try {
    scope.add(() => released.push('engine'));
    scope.add(() => released.push('tool'));
    throw new Error('initialization failed');
  } catch {
    scope.dispose();
  }
  scope.dispose();
  assert.deepEqual(released, ['tool', 'engine']);
});

test('one failed cleanup does not prevent other resources from releasing', () => {
  const scope = new ResourceScope();
  const failure = new Error('tool cleanup failed');
  let engineReleased = false;
  scope.add(() => { engineReleased = true; });
  scope.add(() => { throw failure; });
  assert.throws(() => scope.dispose(), error => error instanceof AggregateError && error.errors[0] === failure);
  assert.equal(engineReleased, true);
  assert.doesNotThrow(() => scope.dispose());
});

test('resources registered after disposal are released immediately', () => {
  const scope = new ResourceScope();
  scope.dispose();
  let released = 0;
  scope.add(() => { released++; });
  assert.equal(released, 1);
});
