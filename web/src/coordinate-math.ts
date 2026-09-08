export type XYZ = [number, number, number];
export type Matrix = number[][];
export interface TransformParameters { translation: XYZ; rotation_degrees: XYZ; scale: XYZ }

export const identityMatrix = (): Matrix => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

export function multiplyMatrices(a: Matrix, b: Matrix): Matrix {
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) =>
    [0, 1, 2, 3].reduce((sum, index) => sum + a[row][index] * b[index][column], 0)));
}

export function invertAffine(matrix: Matrix): Matrix {
  const a = matrix[0][0], b = matrix[0][1], c = matrix[0][2];
  const d = matrix[1][0], e = matrix[1][1], f = matrix[1][2];
  const g = matrix[2][0], h = matrix[2][1], i = matrix[2][2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-15) throw new Error('预变换矩阵不可逆');
  const linear = [[e * i - f * h, c * h - b * i, b * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, b * g - a * h, a * e - b * d]].map(row => row.map(value => value / det));
  const translation = matrix.slice(0, 3).map(row => row[3]);
  return [...linear.map(row => [...row, -row.reduce((sum, value, index) => sum + value * translation[index], 0)]), [0, 0, 0, 1]];
}

export function transformParametersMatrix(value: TransformParameters): Matrix {
  const [rx, ry, rz] = value.rotation_degrees.map(angle => angle * Math.PI / 180);
  const [sx, sy, sz] = value.scale; const [tx, ty, tz] = value.translation;
  const cx = Math.cos(rx), sxr = Math.sin(rx), cy = Math.cos(ry), syr = Math.sin(ry), cz = Math.cos(rz), szr = Math.sin(rz);
  return [
    [cz * cy * sx, (cz * syr * sxr - szr * cx) * sy, (cz * syr * cx + szr * sxr) * sz, tx],
    [szr * cy * sx, (szr * syr * sxr + cz * cx) * sy, (szr * syr * cx - cz * sxr) * sz, ty],
    [-syr * sx, cy * sxr * sy, cy * cx * sz, tz],
    [0, 0, 0, 1],
  ];
}

export function transformXYZ(matrix: Matrix, point: XYZ): XYZ {
  return [0, 1, 2].map(row => matrix[row][0] * point[0] + matrix[row][1] * point[1]
    + matrix[row][2] * point[2] + matrix[row][3]) as XYZ;
}

export function offsetXYZ(point: XYZ, origin: XYZ, sign = 1): XYZ {
  return point.map((value, index) => value + sign * origin[index]) as XYZ;
}
