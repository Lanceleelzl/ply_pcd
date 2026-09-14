import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import type { PointCloudMaterial } from '../../point-cloud';

export function applyModelRoleColors(entities: Record<ModelId, pc.Entity>, moving: ModelId): void {
  const fixed = moving === 'a' ? 'b' : 'a';
  const recolor = (entity: pc.Entity, color: pc.Color) => entity.render?.meshInstances.forEach(instance => (instance.material as PointCloudMaterial).setPointColor(color));
  recolor(entities[moving], new pc.Color(1.0, 0.72, 0.08));
  recolor(entities[fixed], new pc.Color(0.68, 0.72, 0.78));
}
