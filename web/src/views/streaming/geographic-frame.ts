import { transformParametersMatrix, type TransformParameters, type XYZ } from '../../coordinate-math.ts';

export function geographicDirections(transform: TransformParameters, axes: number[]): XYZ[] {
  const matrix = transformParametersMatrix(transform);
  return axes.map(axis => {
    const column = Math.abs(axis) - 1;
    const vector = matrix.slice(0, 3).map(row => row[column] * Math.sign(axis));
    const length = Math.hypot(...vector);
    return vector.map(value => value / length) as XYZ;
  });
}

export function wgs84Utm(longitude: number, latitude: number): number {
  let zone = Math.min(60, Math.floor((longitude + 180) / 6) + 1);
  if (latitude >= 56 && latitude < 64 && longitude >= 3 && longitude < 12) zone = 32;
  if (latitude >= 72 && latitude < 84 && longitude >= 0 && longitude < 42)
    zone = longitude < 9 ? 31 : longitude < 21 ? 33 : longitude < 33 ? 35 : 37;
  return (latitude >= 0 ? 32600 : 32700) + zone;
}

export function projectedToFile(point: XYZ, origin: XYZ, reference: XYZ, axes: number[], unit: number, factors: number[]): XYZ {
  const offsets = [(point[0] - origin[0]) * factors[0], (point[1] - origin[1]) * factors[1], point[2] - origin[2]];
  const result = [...reference] as XYZ;
  axes.forEach((axis, index) => { result[Math.abs(axis) - 1] += offsets[index] * Math.sign(axis) / unit; });
  return result;
}
