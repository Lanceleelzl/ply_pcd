import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditHistory } from './edit-history.ts';

test('jump, undo, redo and new branch preserve snapshots', () => {
  const history = new EditHistory({ boundaries: [1] }, value => structuredClone(value));
  history.record('新增边界', { boundaries: [1, 2] });
  history.record('移动顶点', { boundaries: [1, 3] });
  assert.deepEqual(history.undo(), { boundaries: [1, 2] });
  assert.deepEqual(history.redo(), { boundaries: [1, 3] });
  assert.deepEqual(history.jump(0), { boundaries: [1] });
  history.record('新分支', { boundaries: [4] });
  assert.equal(history.entries.length, 2);
  assert.equal(history.canRedo, false);
  const copy = history.current;
  copy.boundaries.push(5);
  assert.deepEqual(history.current, { boundaries: [4] });
  const restored = new EditHistory<{ boundaries: number[] }>({ boundaries: [] }, value => structuredClone(value));
  restored.restore(history.serialize());
  assert.deepEqual(restored.undo(), { boundaries: [1] });
});
