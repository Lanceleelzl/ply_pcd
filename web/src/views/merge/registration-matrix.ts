export type Matrix4 = number[][];

export function parseRegistrationMatrix(input: string): Matrix4 {
  const values = input.replace(/[\[\]]/g, ' ').trim().split(/[\s,;]+/).map(Number);
  if (values.length !== 16 || values.some(value => !Number.isFinite(value)))
    throw new Error('请输入 4 行、每行 4 个有限数字的配准矩阵');
  const matrix = Array.from({ length: 4 }, (_, row) => values.slice(row * 4, row * 4 + 4));
  registrationComponents(matrix);
  return matrix;
}

export function registrationComponents(matrix: Matrix4 | null): { scale: number; rotation: number[]; translation: number[] } {
  if (!matrix) return { scale: 1, rotation: [1, 0, 0, 0], translation: [0, 0, 0] };
  if (matrix.length !== 4 || matrix.some(row => row.length !== 4 || row.some(value => !Number.isFinite(value))) ||
      matrix[3].some((value, index) => value !== (index === 3 ? 1 : 0)))
    throw new Error('配准矩阵必须是有限的 4×4 仿射矩阵，末行为 0 0 0 1');
  const columns = [0, 1, 2].map(column => [0, 1, 2].map(row => matrix[row][column]));
  const lengths = columns.map(column => Math.hypot(...column));
  const scale = lengths.reduce((sum, value) => sum + value, 0) / 3;
  if (scale < 1e-6 || scale > 1e6 || lengths.some(length => Math.abs(length - scale) > scale * 1e-5))
    throw new Error('配准矩阵仅支持正数等比缩放');
  const r = [0, 1, 2].map(row => [0, 1, 2].map(column => matrix[row][column] / scale));
  if ([[0, 1], [0, 2], [1, 2]].some(([left, right]) =>
    Math.abs(r.reduce((sum, row) => sum + row[left] * row[right], 0)) > 1e-5))
    throw new Error('配准矩阵不能包含剪切');
  const determinant = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
    - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
    + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  if (Math.abs(determinant - 1) > 1e-5) throw new Error('配准矩阵不能包含镜像或退化变换');
  const trace = r[0][0] + r[1][1] + r[2][2];
  let rotation: number[];
  if (trace > 0) {
    const root = Math.sqrt(trace + 1) * 2;
    rotation = [root / 4, (r[2][1] - r[1][2]) / root, (r[0][2] - r[2][0]) / root, (r[1][0] - r[0][1]) / root];
  } else {
    const index = [0, 1, 2].reduce((best, axis) => r[axis][axis] > r[best][best] ? axis : best, 0);
    const next = (index + 1) % 3, last = (index + 2) % 3;
    const root = Math.sqrt(1 + r[index][index] - r[next][next] - r[last][last]) * 2;
    const vector = [0, 0, 0];
    vector[index] = root / 4;
    vector[next] = (r[next][index] + r[index][next]) / root;
    vector[last] = (r[last][index] + r[index][last]) / root;
    rotation = [(r[last][next] - r[next][last]) / root, ...vector];
  }
  return { scale, rotation, translation: [matrix[0][3], matrix[1][3], matrix[2][3]] };
}

export function multiplyQuaternions(first: number[], second: number[]): number[] {
  const [a, b, c, d] = first, [w, x, y, z] = second;
  return [a * w - b * x - c * y - d * z, a * x + b * w + c * z - d * y,
    a * y - b * z + c * w + d * x, a * z + b * y - c * x + d * w];
}
