import * as pc from 'playcanvas';
import { identityMatrix, multiplyMatrices, offsetXYZ, transformParametersMatrix, transformXYZ, type Matrix, type TransformParameters, type XYZ } from './coordinate-math.ts';

type Model = 'a' | 'b';
const models: Model[] = ['a', 'b'];
const translation = (point: XYZ): Matrix => [[1,0,0,point[0]], [0,1,0,point[1]], [0,0,1,point[2]], [0,0,0,1]];

// Only uniform-scale poses or a single TRS are decomposed; the composed display can contain shear.
function uniformScale(matrix: Matrix): number {
  return Math.hypot(matrix[0][0], matrix[1][0], matrix[2][0]);
}

function setSimilarity(entity: pc.Entity, matrix: Matrix): void {
  const scale = uniformScale(matrix);
  const rotation = new pc.Mat4().set(Array.from({ length: 16 }, (_, index) =>
    index % 4 < 3 && Math.floor(index / 4) < 3 ? matrix[index % 4][Math.floor(index / 4)] / scale : matrix[index % 4][Math.floor(index / 4)]));
  entity.setLocalPosition(matrix[0][3], matrix[1][3], matrix[2][3]);
  entity.setLocalRotation(new pc.Quat().setFromMat4(rotation).normalize());
  entity.setLocalScale(scale, scale, scale);
}

function rigidPose(position: pc.Vec3, rotation: pc.Quat): Matrix {
  const { x, y, z, w } = rotation.clone().normalize();
  return [[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w), position.x],
    [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w), position.y],
    [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y), position.z], [0,0,0,1]];
}

export class RegistrationDisplay {
  readonly businessMatrices: Record<Model, Matrix> = { a: identityMatrix(), b: identityMatrix() };
  readonly handle = new pc.Entity('Registration rigid handle');
  private parents: Record<Model, pc.Entity>;
  private moving: Model = 'a';
  private original = false;
  private movingLocalToFixedLocal = identityMatrix();
  private anchor: XYZ | null = null;

  constructor(root: pc.Entity, private entities: Record<Model, pc.Entity>,
    private origins: Record<Model, XYZ>, private parameters: Record<Model, TransformParameters>) {
    this.parents = { a: new pc.Entity('A business frame'), b: new pc.Entity('B business frame') };
    models.forEach(model => {
      root.addChild(this.parents[model]);
      entities[model].reparent(this.parents[model]);
    });
    root.addChild(this.handle);
  }

  private get fixed(): Model { return this.moving === 'a' ? 'b' : 'a'; }

  reset(moving: Model): void {
    this.moving = moving;
    this.original = false;
    models.forEach(model => { this.businessMatrices[model] = transformParametersMatrix(this.parameters[model]); });
    this.anchor ??= this.businessOrigin('a');
    this.setMovingLocalToFixedLocal(translation(offsetXYZ(this.businessOrigin(moving), this.businessOrigin(this.fixed), -1)));
  }

  getMovingLocalToFixedLocal(): Matrix { return this.movingLocalToFixedLocal.map(row => [...row]); }

  setMovingLocalToFixedLocal(matrix: Matrix): void {
    this.movingLocalToFixedLocal = matrix.map(row => [...row]);
    this.refresh();
    this.syncHandle();
  }

  setOriginal(original: boolean): void { this.original = original; this.refresh(); }

  private base(model: Model): Matrix {
    return this.businessMatrices[model].map((row, index) => index < 3 ? [...row.slice(0, 3), 0] : [...row]);
  }

  private businessOrigin(model: Model): XYZ {
    return transformXYZ(this.businessMatrices[model], this.origins[model]);
  }

  private parentMatrix(model: Model): Matrix {
    const frame = translation(offsetXYZ(this.businessOrigin(this.original ? model : this.fixed), this.anchor!, -1));
    if (this.original) return frame;
    return multiplyMatrices(frame, model === this.moving ? this.movingLocalToFixedLocal : identityMatrix());
  }

  localToDisplay(model: Model): Matrix {
    return multiplyMatrices(this.parentMatrix(model), this.base(model));
  }

  signature(): string { return JSON.stringify([this.moving, this.movingLocalToFixedLocal, this.businessMatrices]); }

  private refresh(): void {
    models.forEach(model => {
      const parameter = this.parameters[model];
      setSimilarity(this.parents[model], this.parentMatrix(model));
      this.entities[model].setLocalPosition(0, 0, 0);
      this.entities[model].setLocalEulerAngles(...parameter.rotation_degrees);
      this.entities[model].setLocalScale(...parameter.scale);
    });
  }

  private syncHandle(): void {
    setSimilarity(this.handle, this.parentMatrix(this.moving));
    this.handle.setLocalScale(1, 1, 1);
  }

  applyHandle(): void {
    const position = offsetXYZ(this.handle.getLocalPosition().toArray() as XYZ, offsetXYZ(this.businessOrigin(this.fixed), this.anchor!, -1), -1);
    const rotation = this.handle.getLocalRotation();
    const rigid = rigidPose(new pc.Vec3(...position), rotation);
    const scale = uniformScale(this.movingLocalToFixedLocal);
    this.movingLocalToFixedLocal = rigid.map((row, index) => index < 3
      ? row.map((value, column) => column < 3 ? value * scale : value) : row);
    this.refresh();
  }

  setPose(position: XYZ, rotation: XYZ, scale = 1): void {
    this.setMovingLocalToFixedLocal(transformParametersMatrix({ translation: position, rotation_degrees: rotation, scale: [scale,scale,scale] }));
  }

  getPose(): { position: XYZ; rotation: XYZ; scale: number } {
    const pose = new pc.Entity();
    setSimilarity(pose, this.movingLocalToFixedLocal);
    return { position: pose.getLocalPosition().toArray() as XYZ, rotation: pose.getLocalEulerAngles().toArray() as XYZ,
      scale: Number(uniformScale(this.movingLocalToFixedLocal).toPrecision(15)) };
  }
}
