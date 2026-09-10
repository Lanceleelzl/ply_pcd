export type RangeAxis = 'x' | 'y' | 'z';
export type RangeSide = 'min' | 'max';
export type AxisRangeState = Record<RangeAxis, { min: number; max: number; minEnabled: boolean; maxEnabled: boolean }>;

export function createAxisRange(min: Record<RangeAxis, number>, max: Record<RangeAxis, number>): AxisRangeState {
  return Object.fromEntries((['x', 'y', 'z'] as const).map(axis => [axis, {
    min: Number(min[axis].toFixed(3)), max: Number(max[axis].toFixed(3)), minEnabled: false, maxEnabled: false,
  }])) as AxisRangeState;
}

export function setAxisRangeBoundary(state: AxisRangeState, axis: RangeAxis, side: RangeSide, value: number): void {
  if (!Number.isFinite(value)) return;
  const range = state[axis];
  const opposite = side === 'min' ? 'max' : 'min';
  const bounded = range[`${opposite}Enabled`]
    ? (side === 'min' ? Math.min(value, range[opposite]) : Math.max(value, range[opposite])) : value;
  range[side] = Number(bounded.toFixed(3));
  range[`${side}Enabled`] = true;
}
