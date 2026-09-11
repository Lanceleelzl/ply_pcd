import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restoreRegistrationHistory } from './registration-history.ts';
import { identityMatrix } from '../coordinate-math.ts';
import type { RegistrationResult, RegistrationSession } from '../api/contracts';

const records: RegistrationSession['registrations'] = [{
  job_id: 'latest', status: 'succeeded', result_url: '/result', output_direction: 'b_to_a', parameters: { sampling_limit: 60000 },
}];
const result = (): RegistrationResult => ({
  coordinate_space: 'business', moving_model: 'b', moving_local_to_fixed_local: identityMatrix(),
  a_to_b: identityMatrix(), b_to_a: identityMatrix(),
  recommended_matrix: { name: 'b_to_a', formula: '', value: identityMatrix() },
  metrics: { final_rms: 0.2, final_point_count: 1000, elapsed_seconds: 1 },
});
function setup() {
  const controller = new AbortController();
  const state = { signature: 'initial', running: false, unavailable: 0 };
  const restored: unknown[] = [];
  const context = {
    signature: () => state.signature, running: () => state.running,
    businessMatrices: { a: identityMatrix(), b: identityMatrix() },
    apply: (value: RegistrationResult, record: unknown) => { restored.push({ value, record }); },
    unavailable: () => { state.unavailable++; },
  };
  return { controller, state, context, restored, run: () => restoreRegistrationHistory(records, controller.signal, context) };
}

test('matching history restores its result, direction and parameters; missing presets mean identity', async context => {
  const value = result();
  context.mock.method(globalThis, 'fetch', async () => Response.json(value));
  const history = setup();
  await history.run();
  assert.deepEqual(history.restored, [{ value, record: records[0] }]);
});

test('only the latest successful entry is eligible; disposed loads send no request', async context => {
  const request = context.mock.method(globalThis, 'fetch');
  const history = setup();
  for (const entries of [undefined, [], [...records, { ...records[0], status: 'failed' }], [{ ...records[0], result_url: undefined }]]) {
    await restoreRegistrationHistory(entries, history.controller.signal, history.context);
  }
  history.controller.abort();
  await history.run();
  assert.equal(request.mock.callCount(), 0);
});

test('file-space results and changed business matrices cannot restore', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json({ ...result(), coordinate_space: 'file' }));
  const history = setup();
  await history.run();
  request.mock.mockImplementation(async () => Response.json(result()));
  history.context.businessMatrices.a[0][3] = 1;
  await history.run();
  assert.deepEqual(history.restored, []);
  assert.equal(history.state.unavailable, 0);
});

test('the existing double precision matrix tolerance is preserved for both models', async context => {
  const value = result();
  value.business_transforms = { a: { matrix: identityMatrix() }, b: { matrix: identityMatrix() } };
  context.mock.method(globalThis, 'fetch', async () => Response.json(value));
  const history = setup();
  value.business_transforms.b.matrix[0][3] = 5e-13;
  await history.run();
  assert.equal(history.restored.length, 1);
  value.business_transforms.b.matrix[0][3] = 2e-12;
  await history.run();
  assert.equal(history.restored.length, 1);
});

test('late success cannot override edits, a running job or a disposed scene', async context => {
  let respond!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  for (const change of ['edit', 'run', 'dispose']) {
    const history = setup();
    const pending = history.run();
    if (change === 'edit') history.state.signature = 'edited';
    if (change === 'run') history.state.running = true;
    if (change === 'dispose') history.controller.abort();
    respond(Response.json(result()));
    await pending;
    assert.deepEqual(history.restored, []);
    assert.equal(history.state.unavailable, 0);
  }
});

test('current HTTP errors are reported but stale failures cannot override new state', async context => {
  let respond!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  for (const change of ['none', 'edit', 'run', 'dispose']) {
    const history = setup();
    const pending = history.run();
    if (change === 'edit') history.state.signature = 'edited';
    if (change === 'run') history.state.running = true;
    if (change === 'dispose') history.controller.abort();
    respond(new Response('unavailable', { status: 503 }));
    await pending;
    assert.equal(history.state.unavailable, change === 'none' ? 1 : 0, change);
  }
});
