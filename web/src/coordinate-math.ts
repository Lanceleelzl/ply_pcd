export type XYZ = [number, number, number];
export type Matrix = number[][];

export function transformXYZ(matrix: Matrix, point: XYZ): XYZ {
  return [0, 1, 2].map(row => matrix[row][0] * point[0] + matrix[row][1] * point[1]
    + matrix[row][2] * point[2] + matrix[row][3]) as XYZ;
}

export function offsetXYZ(point: XYZ, origin: XYZ, sign = 1): XYZ {
  return point.map((value, index) => value + sign * origin[index]) as XYZ;
}
