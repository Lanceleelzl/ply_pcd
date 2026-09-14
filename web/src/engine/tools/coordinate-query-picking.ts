import * as pc from 'playcanvas';
import type { PreviewCloud } from '../../point-cloud';

interface CoordinateQueryPickingOptions {
  cloud: PreviewCloud;
  localToWorld: pc.Mat4;
  cameraPosition: pc.Vec3;
  cameraForward: pc.Vec3;
  nearClip: number;
  screenX: number;
  screenY: number;
  radius: number;
  visiblePoint(world: pc.Vec3): boolean;
  worldToScreen(world: pc.Vec3, screen: pc.Vec3): void;
}

export function pickVisiblePreviewPoint(options: CoordinateQueryPickingOptions): number {
  const { cloud } = options;
  let best = -1;
  let bestDepth = Number.POSITIVE_INFINITY;
  const local = new pc.Vec3();
  const world = new pc.Vec3();
  const screen = new pc.Vec3();
  for (let index = 0; index < cloud.count; index++) {
    local.set(cloud.positions[index * 3], cloud.positions[index * 3 + 1], cloud.positions[index * 3 + 2]);
    options.localToWorld.transformPoint(local, world);
    if (!options.visiblePoint(world)) continue;
    const depth = world.clone().sub(options.cameraPosition).dot(options.cameraForward);
    if (depth <= options.nearClip || depth >= bestDepth) continue;
    options.worldToScreen(world, screen);
    if ((screen.x - options.screenX) ** 2 + (screen.y - options.screenY) ** 2 <= options.radius ** 2) {
      best = index;
      bestDepth = depth;
    }
  }
  return best;
}
