import { strict as assert } from 'node:assert';
import { decomposeMatrix, parseMatrix } from './home-matrix.ts';
import { transformParametersMatrix, type XYZ } from './coordinate-math.ts';

for (const angles of [[23, -48, 170], [10, 90, 30], [10, -90, 30], [0, 0, 0]]) {
  for (const scale of [[1, 2, 3], [-2, 3, 4], [-2, -3, 4]]) {
    const matrix = transformParametersMatrix({ translation: [-500000.125, 4000000, -12], rotation_degrees: angles as XYZ, scale: scale as XYZ });
    const rebuilt = transformParametersMatrix(decomposeMatrix(parseMatrix(JSON.stringify(matrix))));
    matrix.flat().forEach((value, i) => assert.ok(Math.abs(value - rebuilt.flat()[i]) < 1e-7));
  }
}
assert.equal(parseMatrix('1e0\t0 0 -1.2e3\n0 1 0 0\n0 0 1 0\n0 0 0 1')[0][3], -1200);
for (const text of ['', '1 2 3', '1 '.repeat(15) + 'NaN', '1 '.repeat(15) + '1e999']) assert.throws(() => decomposeMatrix(parseMatrix(text)));
assert.throws(() => decomposeMatrix([[1, 1, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]));
assert.throws(() => decomposeMatrix([[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]));
assert.throws(() => decomposeMatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 0, 1]]));
console.log('Home matrix: paste, signed scale, gimbal lock, round trips and invalid inputs passed');
