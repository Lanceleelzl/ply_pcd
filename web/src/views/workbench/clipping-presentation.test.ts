import assert from 'node:assert/strict';
import test from 'node:test';
import { clippingPresentation } from './clipping-presentation.ts';

test('builds clipping toolbar and viewport presentation', () => {
  const view = clippingPresentation('joint', 'box', { a: 'off', b: 'off' }, 'box');
  assert.equal(view.active, true);
  assert.match(view.title, /联合剖切/);
  assert.match(view.help, /长方体/);
});
