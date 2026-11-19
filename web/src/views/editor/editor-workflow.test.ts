import assert from 'node:assert/strict';
import test from 'node:test';
import { moveLodFile, resultSnapshot } from './editor-workflow.ts';

test('LOD reordering moves the file and matching upload path together without mutating inputs', () => {
  const files = ['coarse.ply', 'fine.ply'], paths = ['a/coarse.ply', 'b/fine.ply'];
  assert.deepEqual(moveLodFile(files, paths, 1, -1), {
    files: ['fine.ply', 'coarse.ply'], paths: ['b/fine.ply', 'a/coarse.ply'] });
  assert.deepEqual(files, ['coarse.ply', 'fine.ply']);
  assert.deepEqual(moveLodFile(files, paths, 0, -1), { files, paths });
  assert.deepEqual(moveLodFile(files, paths, 1, 1), { files, paths });
});

test('restoring a frozen version does not guess history indexes or mutate its saved state', () => {
  const version = { state: { rules: [{ type: 'sphere' as const, action: 'keep' as const,
    center: [0, 0, 0] as [number, number, number], radius: 2 }], selected_lods: [0, 1] } };
  const state = resultSnapshot(version)!;
  state.selected_lods.pop();
  assert.deepEqual(version.state.selected_lods, [0, 1]);
  assert.equal(resultSnapshot({}), null);
});
