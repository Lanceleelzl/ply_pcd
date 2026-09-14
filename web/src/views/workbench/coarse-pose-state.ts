import * as pc from 'playcanvas';
import type { XYZ } from '../../coordinate-math';

export function splitCoarsePose(values: number[]): { position: XYZ; rotation: XYZ } {
  return {
    position: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0],
    rotation: [values[3] ?? 0, values[4] ?? 0, values[5] ?? 0],
  };
}

export function poseValues(position: pc.Vec3, rotation: pc.Vec3): number[] {
  return [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z];
}
