import { strict as assert } from 'node:assert';
import * as pc from 'playcanvas';
import { RegistrationDisplay } from './registration-display.ts';
import { identityMatrix, invertAffine, multiplyMatrices, transformParametersMatrix, transformXYZ, type XYZ } from './coordinate-math.ts';

const close = (a: number[], b: number[], tolerance = 1e-8) => assert.ok(a.every((value, i) => Math.abs(value-b[i]) < tolerance), `${a} != ${b}`);
const rigid = (matrix: number[][]) => {
  for (let i=0; i<3; i++) for (let j=0; j<3; j++) close([matrix.slice(0,3).reduce((sum,row) => sum+row[i]*row[j],0)], [i === j ? 1 : 0]);
};
const root = new pc.Entity('Test root');
const entities = { a: new pc.Entity('A'), b: new pc.Entity('B') };
root.addChild(entities.a); root.addChild(entities.b);
const origins = { a: [500000,4000000,30] as XYZ, b: [500001,4000002,33] as XYZ };
const parameters = {
  a: { translation: [2,3,4] as XYZ, rotation_degrees: [-90,20,30] as XYZ, scale: [1,2,3] as XYZ },
  b: { translation: [-1,5,6] as XYZ, rotation_degrees: [10,40,50] as XYZ, scale: [3,1,2] as XYZ },
};
const display = new RegistrationDisplay(root, entities, origins, parameters);
for (const moving of ['a','b'] as const) {
  const fixed = moving === 'a' ? 'b' : 'a';
  display.reset(moving);
  rigid(display.getMovingLocalToFixedLocal());
  close(display.getMovingLocalToFixedLocal().slice(0,3).map(row => row[3]), origins[moving].map((value,i) => value-origins[fixed][i]));
  const pose = transformParametersMatrix({ translation: [2.123456789,3,4], rotation_degrees: [20,-30,60], scale: [1,1,1] });
  display.setMovingLocalToFixedLocal(pose);
  assert.deepEqual(display.getMovingLocalToFixedLocal(), pose);
  const point: XYZ = [1,2,3];
  const expected = transformXYZ(display.localToDisplay(fixed), transformXYZ(pose, point));
  close(transformXYZ(display.localToDisplay(moving), point), expected);
  // The engine hierarchy must preserve shear instead of decomposing the combined matrix.
  close(entities[moving].getWorldTransform().transformPoint(new pc.Vec3(...point)).toArray(), expected, 1e-5);
  const before = display.getMovingLocalToFixedLocal();
  const signature = display.signature();
  display.setOriginal(true);
  const originalWorld = transformXYZ(display.businessMatrices[moving], point.map((value,i) => value+origins[moving][i]) as XYZ);
  const anchor = transformXYZ(display.businessMatrices[fixed], origins[fixed]);
  close(transformXYZ(display.localToDisplay(moving), point), originalWorld.map((value,i) => value-anchor[i]));
  assert.equal(display.signature(), signature);
  display.setOriginal(false);
  assert.deepEqual(display.getMovingLocalToFixedLocal(), before);
  close(transformXYZ(display.localToDisplay(moving), point), expected);
  // World-space handle movement becomes a file-space translation without introducing scale.
  const handlePosition = display.handle.getPosition().clone().add(new pc.Vec3(1,2,3));
  display.handle.setPosition(handlePosition);
  display.handle.setRotation(new pc.Quat().setFromEulerAngles(40,20,10));
  display.applyHandle();
  rigid(display.getMovingLocalToFixedLocal());
  close(transformXYZ(display.localToDisplay(moving), [0,0,0]), handlePosition.toArray());
  close(multiplyMatrices(invertAffine(display.localToDisplay(moving)), display.localToDisplay(moving)).flat(), identityMatrix().flat());
}
console.log('Registration display: both roles, nonuniform scale, shear, large origins, original view, rigid handle and inverse passed');
