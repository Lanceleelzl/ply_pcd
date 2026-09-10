import { strict as assert } from 'node:assert';
import { createAxisRange, setAxisRangeBoundary } from './axis-range.ts';

const state = createAxisRange({ x: -10, y: -20, z: -30 }, { x: 10, y: 20, z: 30 });
setAxisRangeBoundary(state, 'x', 'min', 15);
assert.equal(state.x.min, 15, 'disabled maximum does not clamp minimum');
setAxisRangeBoundary(state, 'x', 'max', 5);
assert.equal(state.x.max, 15, 'enabled minimum bounds maximum');
setAxisRangeBoundary(state, 'x', 'min', 20);
assert.equal(state.x.min, 15);
const snapshot = JSON.stringify(state);
for (const invalid of [NaN, Infinity, -Infinity]) setAxisRangeBoundary(state, 'x', 'min', invalid);
assert.equal(JSON.stringify(state), snapshot);
setAxisRangeBoundary(state, 'y', 'max', 1.23456);
assert.equal(state.y.max, 1.235);
assert.equal(state.y.maxEnabled, true);
assert.equal(state.z.minEnabled, false);
console.log('Axis range: disabled bounds, opposing bounds, finite values, rounding and axis isolation passed');
