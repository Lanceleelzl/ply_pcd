import type { Matrix4 } from '../../api/contracts';

export function formatMatrix(matrix: Matrix4, digits = 12): string {
  return matrix.map(row => row.map(value => value.toFixed(digits)).join(' ')).join('\n');
}

export function formatMovingLocalToFixedLocal(matrix: Matrix4): string {
  return formatMatrix(matrix);
}
