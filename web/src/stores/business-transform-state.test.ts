import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBusinessTransformState, defaultBusinessTransform } from './business-transform-state.ts';

function setup() {
  const initial = { a: defaultBusinessTransform(), b: defaultBusinessTransform() };
  const controller = new AbortController();
  const applied: unknown[] = [];
  const business = createBusinessTransformState('a/b', initial, controller.signal, value => applied.push(value));
  return { initial, controller, applied, ...business };
}

test('draft edits stay separate until saving succeeds and preserve the API payload', async context => {
  const request = context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const business = setup();
  business.drafts.a.translation[0] = '-123.456';
  business.drafts.b.scale[1] = '';
  assert.equal(business.initial.a.translation[0], 0);
  await business.apply();
  const [url, options] = request.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, '/api/v2/registration-sessions/a%2Fb/business-transforms');
  assert.equal(options.method, 'PUT');
  const body = JSON.parse(options.body as string);
  assert.equal(body.model_a.translation[0], -123.456);
  assert.deepEqual(body.model_b, defaultBusinessTransform());
  assert.deepEqual(business.applied, [{ a: body.model_a, b: body.model_b }]);
  assert.equal(business.state.saving, false);
});

test('invalid numbers and nonpositive scales never send a request', async context => {
  const request = context.mock.method(globalThis, 'fetch');
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    const business = setup();
    business.drafts.a.scale[0] = value;
    await business.apply();
    assert.match(business.state.message, /应用失败/);
    assert.equal(business.state.saving, false);
    assert.deepEqual(business.applied, []);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('saving prevents repeated requests and reset; HTTP failures preserve applied state', async context => {
  let respond!: (response: Response) => void;
  const request = context.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  const business = setup();
  business.drafts.a.translation[0] = '12';
  const pending = business.apply();
  await business.apply();
  business.reset();
  assert.equal(business.drafts.a.translation[0], '12');
  assert.equal(request.mock.callCount(), 1);
  respond(new Response('unavailable', { status: 503 }));
  await pending;
  assert.match(business.state.message, /HTTP 503/);
  assert.deepEqual(business.applied, []);
  assert.equal(business.state.saving, false);
  business.reset();
  assert.equal(business.drafts.a.translation[0], '0');
});

test('late response after disposal cannot update the scene or publish success', async context => {
  let respond!: (response: Response) => void;
  context.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => { respond = resolve; }));
  const business = setup();
  const pending = business.apply();
  business.controller.abort();
  respond(Response.json({}));
  await pending;
  assert.deepEqual(business.applied, []);
  assert.equal(business.state.message, '');
});

test('disposal during JSON parsing also blocks the scene callback', async context => {
  const business = setup();
  context.mock.method(globalThis, 'fetch', async () => ({
    ok: true, json: async () => { business.controller.abort(); return {}; },
  } as Response));
  await business.apply();
  assert.deepEqual(business.applied, []);
  assert.equal(business.state.message, '');
});

test('disabled or disposed state cannot submit', async context => {
  const request = context.mock.method(globalThis, 'fetch');
  const business = setup();
  business.state.disabled = true;
  await business.apply();
  business.state.disabled = false;
  business.controller.abort();
  await business.apply();
  assert.equal(request.mock.callCount(), 0);
});
