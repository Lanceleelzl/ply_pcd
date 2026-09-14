import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';

export interface ClipBoxModel {
  min: pc.Vec3;
  max: pc.Vec3;
  transform: pc.Mat4;
}

export function worldBounds(models: ModelId[], clouds: Record<ModelId, ClipBoxModel>) {
  const min = new pc.Vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = new pc.Vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  models.forEach(model => {
    const cloud = clouds[model];
    for (const x of [cloud.min.x, cloud.max.x]) for (const y of [cloud.min.y, cloud.max.y]) for (const z of [cloud.min.z, cloud.max.z]) {
      const point = cloud.transform.transformPoint(new pc.Vec3(x, y, z));
      min.min(point); max.max(point);
    }
  });
  return { min, max };
}

export function fitClipBox(box: pc.Entity, bounds: { min: pc.Vec3; max: pc.Vec3 }): void {
  const size = bounds.max.clone().sub(bounds.min);
  box.setPosition(bounds.min.clone().add(bounds.max).mulScalar(0.5));
  box.setEulerAngles(0, 0, 0);
  box.setLocalScale(Math.max(size.x, 0.001), Math.max(size.y, 0.001), Math.max(size.z, 0.001));
}
