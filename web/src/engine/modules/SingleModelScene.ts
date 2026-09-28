import * as pc from 'playcanvas';
import { transformParametersMatrix, transformXYZ, type TransformParameters, type XYZ } from '../../coordinate-math.ts';
import { createPointCloudEntity, type PointCloudMaterial, type PreviewCloud } from '../../point-cloud.ts';
import { pickVisiblePreviewPoint } from '../tools/coordinate-query-picking.ts';

export class SingleModelScene {
  readonly root = new pc.Entity('Single model scene');
  readonly points: pc.Entity;
  readonly baseDiagonal: number;
  readonly displayOrigin: XYZ;
  readonly material: PointCloudMaterial;
  private transform: TransformParameters;
  private readonly app: pc.Application;
  private readonly originPlanes: Record<'xoy' | 'xoz' | 'yoz', pc.Entity>;
  private readonly helperMaterials: pc.StandardMaterial[] = [];
  private axesVisible = false;
  private readonly originFrame = new pc.Entity('Single model file origin');
  private visiblePoint: (point: pc.Vec3) => boolean = () => true;

  constructor(app: pc.Application, readonly cloud: PreviewCloud, readonly fileOrigin: XYZ,
    transform: TransformParameters) {
    this.app = app;
    app.root.addChild(this.root);
    this.points = createPointCloudEntity(app, cloud, new pc.Color(0.68, 0.78, 0.94), 'Model points');
    this.root.addChild(this.points);
    this.material = this.points.render!.meshInstances[0].material as PointCloudMaterial;
    this.baseDiagonal = Math.max(cloud.max.clone().sub(cloud.min).length(), 0.01);
    this.transform = transform;
    this.displayOrigin = transformXYZ(transformParametersMatrix(transform), fileOrigin);
    this.originFrame.setLocalPosition(-fileOrigin[0], -fileOrigin[1], -fileOrigin[2]);
    this.root.addChild(this.originFrame);
    const createPlane = (name: string, color: pc.Color, rotation: XYZ) => {
      const entity = new pc.Entity(name); entity.addComponent('render', { type: 'plane' });
      entity.setLocalScale(this.baseDiagonal * 0.7, 1, this.baseDiagonal * 0.7);
      entity.setLocalEulerAngles(...rotation); entity.enabled = false;
      const material = new pc.StandardMaterial(); material.diffuse = color; material.emissive = color.clone().mulScalar(0.2);
      material.opacity = 0.3; material.blendType = pc.BLEND_NORMAL; material.depthWrite = false;
      material.cull = pc.CULLFACE_NONE; material.update();
      this.helperMaterials.push(material);
      entity.render!.meshInstances.forEach(instance => { instance.material = material; });
      this.originFrame.addChild(entity); return entity;
    };
    this.originPlanes = {
      xoy: createPlane('XOY origin plane', new pc.Color(0.2, 0.48, 1), [90, 0, 0]),
      xoz: createPlane('XOZ origin plane', new pc.Color(0.2, 0.82, 0.48), [0, 0, 0]),
      yoz: createPlane('YOZ origin plane', new pc.Color(1, 0.32, 0.28), [0, 0, 90]),
    };
    this.app.on('update', this.drawAxes, this);
    this.applyTransform(transform);
  }

  applyTransform(transform: TransformParameters): void {
    this.transform = transform;
    const origin = transformXYZ(transformParametersMatrix(transform), this.fileOrigin);
    this.root.setLocalPosition(origin[0] - this.displayOrigin[0],
      origin[1] - this.displayOrigin[1], origin[2] - this.displayOrigin[2]);
    const [rx, ry, rz] = transform.rotation_degrees;
    this.root.setLocalEulerAngles(rx, ry, rz);
    this.root.setLocalScale(...transform.scale);
  }

  setPointsVisible(visible: boolean): void { this.points.render!.enabled = visible; }
  setAxesVisible(visible: boolean): void { this.axesVisible = visible; }
  setOriginPlane(plane: 'xoy' | 'xoz' | 'yoz', visible: boolean): void { this.originPlanes[plane].enabled = visible; }
  worldToOrigin(): pc.Mat4 { return this.originFrame.getWorldTransform().clone().invert(); }

  setClipState(enabled: boolean, min: pc.Vec3, max: pc.Vec3, boxEnabled: boolean,
    worldToBox: pc.Mat4, originSides: pc.Vec3, worldToOrigin: pc.Mat4): void {
    this.material.setClipState(enabled, min, max, boxEnabled, worldToBox, originSides, worldToOrigin);
    const boxPoint = new pc.Vec3(); const originPoint = new pc.Vec3();
    this.visiblePoint = point => {
      if (enabled) {
        if (point.x < min.x || point.y < min.y || point.z < min.z
          || point.x > max.x || point.y > max.y || point.z > max.z) return false;
        if (boxEnabled) {
          worldToBox.transformPoint(point, boxPoint);
          if (Math.abs(boxPoint.x) > 0.5 || Math.abs(boxPoint.y) > 0.5 || Math.abs(boxPoint.z) > 0.5) return false;
        }
      }
      worldToOrigin.transformPoint(point, originPoint);
      return (originSides.x === 0 || originSides.x * originPoint.x >= 0)
        && (originSides.y === 0 || originSides.y * originPoint.y >= 0)
        && (originSides.z === 0 || originSides.z * originPoint.z >= 0);
    };
  }

  pickPoint(camera: pc.Entity, screenX: number, screenY: number): XYZ | null {
    const index = pickVisiblePreviewPoint({
      cloud: this.cloud, localToWorld: this.root.getWorldTransform(),
      cameraPosition: camera.getPosition(), cameraForward: camera.forward, nearClip: camera.camera!.nearClip,
      screenX, screenY, radius: 12, visiblePoint: this.visiblePoint,
      worldToScreen: (world, screen) => { camera.camera!.worldToScreen(world, screen); },
    });
    if (index < 0) return null;
    const offset = index * 3;
    return transformXYZ(transformParametersMatrix(this.transform), [
      this.fileOrigin[0] + this.cloud.positions[offset],
      this.fileOrigin[1] + this.cloud.positions[offset + 1],
      this.fileOrigin[2] + this.cloud.positions[offset + 2],
    ]);
  }

  private drawAxes(): void {
    if (!this.axesVisible) return;
    const transform = this.originFrame.getWorldTransform();
    const origin = transform.transformPoint(new pc.Vec3());
    const length = this.baseDiagonal * 0.55;
    this.app.drawLine(origin, transform.transformPoint(new pc.Vec3(length, 0, 0)), pc.Color.RED, false);
    this.app.drawLine(origin, transform.transformPoint(new pc.Vec3(0, length, 0)), pc.Color.GREEN, false);
    this.app.drawLine(origin, transform.transformPoint(new pc.Vec3(0, 0, length)), pc.Color.BLUE, false);
  }

  bounds(): { min: pc.Vec3; max: pc.Vec3 } {
    const matrix = transformParametersMatrix(this.transform);
    const origin = transformXYZ(matrix, this.fileOrigin);
    for (let axis = 0; axis < 3; axis++) matrix[axis][3] = origin[axis] - this.displayOrigin[axis];
    const min = new pc.Vec3(Infinity, Infinity, Infinity);
    const max = new pc.Vec3(-Infinity, -Infinity, -Infinity);
    for (const x of [this.cloud.min.x, this.cloud.max.x])
      for (const y of [this.cloud.min.y, this.cloud.max.y])
        for (const z of [this.cloud.min.z, this.cloud.max.z]) {
          const point = new pc.Vec3(...transformXYZ(matrix, [x, y, z]));
          min.min(point); max.max(point);
        }
    return { min, max };
  }

  destroy(): void {
    this.app.off('update', this.drawAxes, this); this.material.destroy();
    this.helperMaterials.forEach(material => material.destroy()); this.root.destroy();
  }
}
