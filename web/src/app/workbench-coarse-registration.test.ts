import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkbenchCoarseRegistration } from './workbench-coarse-registration.ts';
import type { Matrix4 } from '../api/contracts.ts';

const identity: Matrix4 = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const candidate: Matrix4 = [[1, 0, 0, 2], [0, 1, 0, -1], [0, 0, 1, 0.5], [0, 0, 0, 1]];

test('automatic coarse candidates require explicit preview and can restore manual pose', async context => {
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/coarse-register')) {
      return Response.json({ job_id: 'job', status_url: '/coarse-status', result_url: '/coarse-result' });
    }
    if (url === '/coarse-status') return Response.json({ status: 'succeeded' });
    return Response.json({
      algorithm: 'cccorelib_4pcs', moving_model: 'a', risk: 'none',
      moving_local_to_fixed_local: candidate,
      candidates: [{ moving_local_to_fixed_local: candidate, overlap: 0.7, random_seed: 42,
        moving_coverage: 1, fixed_coverage: 1, inlier_rms: 0.001, score: 0.9, validation_point_count: 100 }],
      metrics: { moving_coverage: 1, fixed_coverage: 1, inlier_rms: 0.001,
        score: 0.9, validation_point_count: 100, elapsed_seconds: 1 },
    });
  });
  let matrix = identity.map(row => [...row]);
  const poses: number[][] = [];
  const running: boolean[] = [];
  let invalidations = 0;
  const runtime = createWorkbenchCoarseRegistration({
    sessionId: 'session', signal: new AbortController().signal, movingModel: () => 'a',
    display: {
      getMovingLocalToFixedLocal: () => matrix,
      setMovingLocalToFixedLocal: value => { matrix = value.map(row => [...row]); },
      getPose: () => ({ position: [matrix[0][3], matrix[1][3], matrix[2][3]], rotation: [0, 0, 0] }),
    },
    setRunning: value => running.push(value), updatePose: value => poses.push(value),
    invalidateResult: () => { invalidations += 1; }, fitCamera: () => {},
  });
  await runtime.actions.run();
  assert.deepEqual(matrix, identity);
  assert.deepEqual(running, [true, false]);
  runtime.actions.preview(0);
  assert.deepEqual(matrix, candidate);
  runtime.actions.accept(0);
  assert.equal(runtime.initialSource(), '4pcs');
  runtime.markAdjusted();
  assert.equal(runtime.initialSource(), '4pcs_adjusted');
  runtime.actions.discard();
  assert.deepEqual(matrix, identity);
  assert.equal(runtime.initialSource(), 'manual');
  assert.equal(invalidations, 3);
  assert.ok(poses.length >= 2);
  runtime.destroy();
});

test('automatic coarse failure preserves the current manual pose', async context => {
  context.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).endsWith('/coarse-register')) {
      return Response.json({ job_id: 'job', status_url: '/coarse-status', result_url: '/coarse-result' });
    }
    return Response.json({ status: 'failed', error: '没有可靠候选' });
  });
  let matrix = candidate.map(row => [...row]);
  let invalidations = 0;
  const runtime = createWorkbenchCoarseRegistration({
    sessionId: 'session', signal: new AbortController().signal, movingModel: () => 'a',
    display: {
      getMovingLocalToFixedLocal: () => matrix,
      setMovingLocalToFixedLocal: value => { matrix = value.map(row => [...row]); },
      getPose: () => ({ position: [matrix[0][3], matrix[1][3], matrix[2][3]], rotation: [0, 0, 0] }),
    },
    setRunning: () => {}, updatePose: () => {},
    invalidateResult: () => { invalidations += 1; }, fitCamera: () => {},
  });
  await runtime.actions.run();
  assert.deepEqual(matrix, candidate);
  assert.equal(invalidations, 0);
  assert.match(runtime.state.status, /没有可靠候选/);
  assert.equal(runtime.initialSource(), 'manual');
  runtime.destroy();
});
