import { transformParametersMatrix, type Matrix, type TransformParameters, type XYZ } from './coordinate-math.ts';

export function parseMatrix(text: string): Matrix {
  const tokens = text.trim().replace(/[\[\](),;]/g, ' ').trim().split(/\s+/);
  if (tokens.length !== 16 || tokens.some(token => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token))) {
    throw new Error('请输入 16 个有效数值组成的 4×4 矩阵');
  }
  return Array.from({ length: 4 }, (_, row) => tokens.slice(row * 4, row * 4 + 4).map(Number));
}

export function decomposeMatrix(matrix: Matrix): TransformParameters {
  if (matrix.length !== 4 || matrix.some(row => row.length !== 4 || row.some(value => !Number.isFinite(value)))) throw new Error('矩阵必须包含 16 个有限数值');
  if (matrix[3].some((value, index) => Math.abs(value - (index === 3 ? 1 : 0)) > 1e-10)) throw new Error('末行必须为 0、0、0、1');
  const scale = [0, 1, 2].map(column => Math.hypot(...matrix.slice(0, 3).map(row => row[column]))) as XYZ;
  if (scale.some(value => value < 1e-12)) throw new Error('矩阵不可逆，缩放不能为零');
  const r = matrix.slice(0, 3).map(row => row.slice(0, 3).map((value, column) => value / scale[column]));
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  if (det < 0) { scale[0] *= -1; r.forEach(row => { row[0] *= -1; }); }
  const y = Math.asin(Math.max(-1, Math.min(1, -r[2][0])));
  const locked = Math.abs(Math.cos(y)) < 1e-7;
  const x = locked ? Math.atan2(-r[1][2], r[1][1]) : Math.atan2(r[2][1], r[2][2]);
  const z = locked ? 0 : Math.atan2(r[1][0], r[0][0]);
  const result: TransformParameters = { translation: matrix.slice(0, 3).map(row => row[3]) as XYZ, rotation_degrees: [x, y, z].map(value => value * 180 / Math.PI) as XYZ, scale };
  const rebuilt = transformParametersMatrix(result);
  if (r.some((row, i) => row.some((_, j) => Math.abs(rebuilt[i][j] - matrix[i][j]) > Math.abs(scale[j]) * 2e-6))) throw new Error('矩阵含剪切或无法分解为平移、旋转与缩放');
  return result;
}
