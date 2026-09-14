import assert from 'node:assert/strict';
import test from 'node:test';
import { updateClippingDerivedState } from './clipping-derived-state.ts';

test('derives helper visibility and interaction state', () => {
  const values: string[] = [];
  updateClippingDerivedState({ controlMode: 'independent', editor: 'a', jointMode: 'off', jointHelperVisible: true, independentModes: { a: 'box', b: 'off' }, independentHelpers: { a: true, b: true }, panelVisible: true }, v => values.push(`joint:${v}`), (m, v) => values.push(`${m}:${v}`), v => values.push(`interaction:${v}`));
  assert.deepEqual(values, ['joint:false', 'a:true', 'b:false', 'interaction:true']);
});
