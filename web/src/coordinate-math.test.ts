import { strict as assert } from 'node:assert';
import { offsetXYZ, transformXYZ, type XYZ } from './coordinate-math.ts';

const aToB = [[0, -1, 0, 500000], [1, 0, 0, 4000000], [0, 0, 1, -12], [0, 0, 0, 1]];
const bToA = [[0, 1, 0, -4000000], [-1, 0, 0, 500000], [0, 0, 1, 12], [0, 0, 0, 1]];
const a: XYZ = [1.125, 2.25, 3.5];
assert.deepEqual(transformXYZ(aToB, a), [499997.75, 4000001.125, -8.5]);
assert.deepEqual(transformXYZ(bToA, transformXYZ(aToB, a)), a);
const origin: XYZ = [500000, 4000000, 1200];
assert.deepEqual(offsetXYZ(offsetXYZ(a, origin), origin, -1), a);
const yToZ = [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]];
assert.deepEqual(transformXYZ(yToZ, [0, 10, 0]), [0, 0, 10]);
console.log('Coordinate math: rotation, inverse, large origin and axis direction passed');
