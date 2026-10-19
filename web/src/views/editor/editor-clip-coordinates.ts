import type { XYZ } from '../../coordinate-math';

export function clipToLocal(point: XYZ, displayOrigin: XYZ): XYZ {
  return point.map((value, axis) => value - displayOrigin[axis]) as XYZ;
}

export function clipToScene(point: XYZ, displayOrigin: XYZ): XYZ {
  return point.map((value, axis) => value + displayOrigin[axis]) as XYZ;
}
