import type { XYZ } from '../../coordinate-math';
import type { EditorGeography } from '../../api/gaussian-editor-api';

export function projectedOriginForPoint(point: XYZ, frame: EditorGeography,
  projected: [number, number], metresPerProjectedUnit: [number, number]): [number, number] {
  if (frame.axes.map(axis => Math.abs(axis)).sort().join(',') !== '1,2,3'
    || !Number.isFinite(frame.metres_per_unit) || frame.metres_per_unit <= 0
    || ![...point, ...frame.reference, ...projected, ...metresPerProjectedUnit].every(Number.isFinite)
    || metresPerProjectedUnit.some(factor => factor <= 0)) throw new Error('坐标轴、单位或取点坐标无效');
  return projected.map((value, index) => {
    const axis = frame.axes[index];
    const offset = (point[Math.abs(axis) - 1] - frame.reference[Math.abs(axis) - 1])
      * Math.sign(axis) * frame.metres_per_unit / metresPerProjectedUnit[index];
    return value - offset;
  }) as [number, number];
}
