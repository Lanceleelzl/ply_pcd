import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'playcanvas';

// Exercise the actual CSS matrix expressions used by both registration pages.
for (const file of ['generic-registration.ts', 'manual-registration.ts']) {
  const source = readFileSync(new URL(`./pages/${file}`, import.meta.url), 'utf8');
  const expressions = [...source.matchAll(/`matrix3d\(([^`]+)\)`/g)].slice(0, 2);
  assert.equal(expressions.length, 2);
  for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, -2, 3]]) {
    const cameraDirection = new Vec3(...direction).normalize();
    const up = Math.abs(cameraDirection.z) > .99 ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
    const cameraRight = new Vec3().cross(up, cameraDirection).normalize();
    const cubeUp = new Vec3().cross(cameraDirection, cameraRight).normalize();
    const [m, inverse] = expressions.map(([, expression]) =>
      new Function('cameraRight', 'cubeUp', 'cameraDirection', `return \`${expression}\`;`)(cameraRight, cubeUp, cameraDirection).split(',').map(Number));
    const determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    assert.ok(Math.abs(determinant - 1) < 1e-12, `${file}: reflection detected`);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      const product = [0, 1, 2].reduce((sum, k) => sum + m[k * 4 + row] * inverse[col * 4 + k], 0);
      assert.ok(Math.abs(product - Number(row === col)) < 1e-12, `${file}: corner inverse`);
    }
  }
}
console.log('View cube: six axial views and oblique view have no reflection; corner inverse passed');
