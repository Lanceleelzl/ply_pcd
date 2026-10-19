import { transformParametersMatrix, transformXYZ, type TransformParameters, type XYZ } from '../../coordinate-math.ts';

export function transformedClipBounds(bounds: { min: XYZ; max: XYZ }, transform: TransformParameters): { min: XYZ; max: XYZ } {
  const matrix = transformParametersMatrix(transform);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(corner => transformXYZ(matrix,
    [0, 1, 2].map(axis => corner & (1 << axis) ? bounds.max[axis] : bounds.min[axis]) as XYZ));
  return {
    min: [0, 1, 2].map(axis => Math.min(...corners.map(point => point[axis]))) as XYZ,
    max: [0, 1, 2].map(axis => Math.max(...corners.map(point => point[axis]))) as XYZ,
  };
}

export function sliceClipBounds(bounds: { min: XYZ; max: XYZ }, transform: TransformParameters,
  axis: number, thickness: number): { min: XYZ; max: XYZ } {
  const result = transformedClipBounds(bounds, transform);
  const middle = (result.min[axis] + result.max[axis]) / 2;
  result.min[axis] = middle - thickness / 2;
  result.max[axis] = middle + thickness / 2;
  return result;
}

export function clipToLocal(point: XYZ, displayOrigin: XYZ): XYZ {
  return point.map((value, axis) => value - displayOrigin[axis]) as XYZ;
}

export function clipToScene(point: XYZ, displayOrigin: XYZ): XYZ {
  return point.map((value, axis) => value + displayOrigin[axis]) as XYZ;
}
