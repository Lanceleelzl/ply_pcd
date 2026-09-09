import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import type { PointCloudMaterial } from '../../point-cloud';
import type { GaussianDisplayController } from './GaussianDisplayController';
import type { ClippingStateController } from './ClippingStateController';

type Axis = 'x' | 'y' | 'z';
interface AxisState {
  min: pc.Vec3;
  max: pc.Vec3;
  minEnabled: Record<Axis, boolean>;
  maxEnabled: Record<Axis, boolean>;
}

interface ClippingSceneOptions {
  app: pc.Application;
  state: ClippingStateController;
  jointBox: pc.Entity;
  independentBoxes: Record<ModelId, pc.Entity>;
  pointMaterials: Record<ModelId, PointCloudMaterial>;
  gaussian: GaussianDisplayController;
  scope(): 'both' | ModelId;
  axisState(model: ModelId): AxisState;
  originState(model: ModelId): { sides: pc.Vec3; worldToOrigin: pc.Mat4 };
}

const models: ModelId[] = ['a', 'b'];
const axes: Axis[] = ['x', 'y', 'z'];

export class ClippingSceneController {
  private readonly min = { joint: new pc.Vec3(), a: new pc.Vec3(), b: new pc.Vec3() };
  private readonly max = { joint: new pc.Vec3(), a: new pc.Vec3(), b: new pc.Vec3() };
  private readonly worldToBox = { joint: new pc.Mat4(), a: new pc.Mat4(), b: new pc.Mat4() };
  private readonly localCorners: pc.Vec3[] = [];
  private readonly worldCorners: pc.Vec3[] = [];
  private readonly colors = {
    joint: new pc.Color(0.15, 1.0, 0.78),
    a: new pc.Color(0.45, 0.65, 0.9),
    b: new pc.Color(1.0, 0.72, 0.08),
  };

  constructor(private readonly options: ClippingSceneOptions) {
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      this.localCorners.push(new pc.Vec3(x, y, z));
      this.worldCorners.push(new pc.Vec3());
    }
  }

  sync(forceGaussian = false): void {
    models.forEach(model => {
      const independent = this.options.state.controlMode === 'independent';
      const key = independent ? model : 'joint';
      const mode = this.options.state.mode(model);
      const axisState = this.options.axisState(model);
      const min = this.min[key];
      const max = this.max[key];
      min.set(-1e30, -1e30, -1e30);
      max.set(1e30, 1e30, 1e30);
      if (mode === 'axis') axes.forEach(axis => {
        if (axisState.minEnabled[axis]) min[axis] = axisState.min[axis];
        if (axisState.maxEnabled[axis]) max[axis] = axisState.max[axis];
      });
      const box = independent ? this.options.independentBoxes[model] : this.options.jointBox;
      const scale = box.getLocalScale();
      if (Math.abs(scale.x) < 0.001 || Math.abs(scale.y) < 0.001 || Math.abs(scale.z) < 0.001) {
        box.setLocalScale(Math.max(Math.abs(scale.x), 0.001), Math.max(Math.abs(scale.y), 0.001), Math.max(Math.abs(scale.z), 0.001));
      }
      const boxMatrix = this.worldToBox[key];
      boxMatrix.copy(box.getWorldTransform()).invert();
      const enabled = mode !== 'off' && (independent || this.options.scope() === 'both' || this.options.scope() === model);
      const origin = this.options.originState(model);
      this.options.pointMaterials[model].setClipState(enabled, min, max, mode === 'box', boxMatrix, origin.sides, origin.worldToOrigin);
      this.options.gaussian.setClipState(model, enabled, min, max, mode === 'box', boxMatrix, origin.sides, origin.worldToOrigin, forceGaussian);
    });
  }

  drawHelpers(): void {
    if (this.options.state.controlMode === 'joint') {
      if (this.options.state.jointMode === 'box' && this.options.state.jointHelperVisible) {
        this.drawBox(this.options.jointBox, this.colors.joint);
      }
      return;
    }
    models.forEach(model => {
      if (this.options.state.independentModes[model] === 'box' && this.options.state.independentHelpers[model]) {
        this.drawBox(this.options.independentBoxes[model], this.colors[model]);
      }
    });
  }

  visiblePoint(model: ModelId, point: pc.Vec3): boolean {
    const independent = this.options.state.controlMode === 'independent';
    const mode = this.options.state.mode(model);
    if (mode === 'off' || (!independent && this.options.scope() !== 'both' && this.options.scope() !== model)) return true;
    const key = independent ? model : 'joint';
    if (mode === 'box') {
      const local = this.worldToBox[key].transformPoint(point);
      return Math.max(Math.abs(local.x), Math.abs(local.y), Math.abs(local.z)) <= 0.5;
    }
    const min = this.min[key];
    const max = this.max[key];
    return point.x >= min.x && point.x <= max.x && point.y >= min.y && point.y <= max.y && point.z >= min.z && point.z <= max.z;
  }

  private drawBox(box: pc.Entity, color: pc.Color): void {
    const transform = box.getWorldTransform();
    this.localCorners.forEach((corner, index) => transform.transformPoint(corner, this.worldCorners[index]));
    for (let index = 0; index < this.worldCorners.length; index++) for (const bit of [1, 2, 4]) {
      const other = index ^ bit;
      if (index < other) this.options.app.drawLine(this.worldCorners[index], this.worldCorners[other], color, false);
    }
  }
}
