import { reactive } from 'vue';
import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import { ClippingStateController, type ClippingControlMode, type ClippingMode } from '../../engine/modules/ClippingStateController.ts';
import { createAxisRange, setAxisRangeBoundary, type AxisRangeState, type RangeAxis, type RangeSide } from '../../engine/modules/axis-range.ts';

export type ClippingTarget = 'joint' | ModelId;

export interface ClippingBounds {
  min: pc.Vec3;
  max: pc.Vec3;
}

export function createClippingWorkbenchState(bounds: ClippingBounds) {
  const state = reactive(new ClippingStateController());
  const settings = reactive<{ scope: 'both' | ModelId }>({ scope: 'both' });
  const ranges: Record<ClippingTarget, AxisRangeState> = {
    joint: reactive(createAxisRange(bounds.min, bounds.max)),
    a: reactive(createAxisRange(bounds.min, bounds.max)),
    b: reactive(createAxisRange(bounds.min, bounds.max)),
  };
  const axisState = (target: ClippingTarget) => {
    const range = ranges[target];
    return {
      min: new pc.Vec3(range.x.min, range.y.min, range.z.min),
      max: new pc.Vec3(range.x.max, range.y.max, range.z.max),
      minEnabled: { x: range.x.minEnabled, y: range.y.minEnabled, z: range.z.minEnabled },
      maxEnabled: { x: range.x.maxEnabled, y: range.y.maxEnabled, z: range.z.maxEnabled },
    };
  };
  const activeTarget = (): ClippingTarget => state.controlMode === 'joint' ? 'joint' : state.editor;
  const reset = (target: ClippingTarget) => Object.assign(ranges[target], createAxisRange(bounds.min, bounds.max));
  const setBoundary = (target: ClippingTarget, axis: RangeAxis, side: RangeSide, value: number) => {
    setAxisRangeBoundary(ranges[target], axis, side, value);
  };
  const setEnabled = (target: ClippingTarget, axis: RangeAxis, side: RangeSide, value: boolean) => {
    ranges[target][axis][`${side}Enabled`] = value;
  };
  const setControl = (mode: ClippingControlMode) => { state.controlMode = mode; };
  const setEditor = (model: ModelId) => { state.editor = model; };
  const setMode = (target: ClippingTarget, mode: ClippingMode) => {
    if (target === 'joint') state.jointMode = mode;
    else state.independentModes[target] = mode;
  };
  const setHelper = (target: ClippingTarget, visible: boolean) => {
    if (target === 'joint') state.jointHelperVisible = visible;
    else state.independentHelpers[target] = visible;
  };
  const clear = (target: ClippingTarget) => { setMode(target, 'off'); reset(target); };

  return {
    state, settings, ranges, axisState, activeTarget, reset, setBoundary, setEnabled,
    setControl, setEditor, setMode, setHelper, clear,
  };
}
