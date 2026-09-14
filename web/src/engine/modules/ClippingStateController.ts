import type { ModelId } from '../../api/contracts';

export type ClippingMode = 'off' | 'axis' | 'box';
export type ClippingControlMode = 'joint' | 'independent';

export function editedClippingMode(controlMode: ClippingControlMode, jointMode: ClippingMode, editor: ModelId, independentModes: Record<ModelId, ClippingMode>): ClippingMode {
  return controlMode === 'joint' ? jointMode : independentModes[editor];
}

export function isClippingEnabled(controlMode: ClippingControlMode, jointMode: ClippingMode, independentModes: Record<ModelId, ClippingMode>): boolean {
  return controlMode === 'joint' ? jointMode !== 'off' : independentModes.a !== 'off' || independentModes.b !== 'off';
}

export function clippingStateSummary(controlMode: ClippingControlMode, jointMode: ClippingMode, independentModes: Record<ModelId, ClippingMode>): string {
  const modeLabel = (mode: ClippingMode) => mode === 'off' ? '关闭' : mode === 'axis' ? '坐标轴' : '长方体';
  return controlMode === 'joint'
    ? `联合剖切：${modeLabel(jointMode)}`
    : `独立剖切：A ${modeLabel(independentModes.a)}，B ${modeLabel(independentModes.b)}`;
}

export class ClippingStateController {
  controlMode: ClippingControlMode = 'joint';
  editor: ModelId = 'a';
  jointMode: ClippingMode = 'off';
  jointHelperVisible = true;
  readonly independentModes: Record<ModelId, ClippingMode> = { a: 'off', b: 'off' };
  readonly independentHelpers: Record<ModelId, boolean> = { a: true, b: true };

  mode(model: ModelId): ClippingMode {
    return this.controlMode === 'joint' ? this.jointMode : this.independentModes[model];
  }

  editedMode(): ClippingMode {
    return editedClippingMode(this.controlMode, this.jointMode, this.editor, this.independentModes);
  }

  helperVisible(model = this.editor): boolean {
    return this.controlMode === 'joint' ? this.jointHelperVisible : this.independentHelpers[model];
  }

  enabled(): boolean {
    return isClippingEnabled(this.controlMode, this.jointMode, this.independentModes);
  }

  summary(): string {
    return clippingStateSummary(this.controlMode, this.jointMode, this.independentModes);
  }
}
