import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vec3 } from 'playcanvas';

// Exercise the camera orientation matrix used by the workbench view controls.
for (const file of ['views/workbench/view-controls.ts']) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  const expression = source.match(/viewCube\.style\.transform = `matrix3d\(([^`]+)\)`/);
  assert.ok(expression);
  for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, -2, 3]]) {
    const cameraDirection = new Vec3(...direction).normalize();
    const up = Math.abs(cameraDirection.z) > .99 ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
    const cameraRight = new Vec3().cross(up, cameraDirection).normalize();
    const cubeUp = new Vec3().cross(cameraDirection, cameraRight).normalize();
    const m = new Function('right', 'cubeUp', 'direction', `return \`${expression[1]}\`;`)(cameraRight, cubeUp, cameraDirection).split(',').map(Number);
    const determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    assert.ok(Math.abs(determinant - 1) < 1e-12, `${file}: reflection detected`);
  }
}
console.log('View cube: six axial views and oblique view have no reflection');
