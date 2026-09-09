import type { ModelId } from '../../api/contracts';

export type ClippingMode = 'off' | 'axis' | 'box';
export type ClippingControlMode = 'joint' | 'independent';

const models: ModelId[] = ['a', 'b'];

const modeLabel = (mode: ClippingMode) => mode === 'off' ? '关闭' : mode === 'axis' ? '坐标轴' : '长方体';

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
    return this.mode(this.editor);
  }

  helperVisible(model = this.editor): boolean {
    return this.controlMode === 'joint' ? this.jointHelperVisible : this.independentHelpers[model];
  }

  enabled(): boolean {
    return this.controlMode === 'joint'
      ? this.jointMode !== 'off'
      : models.some(model => this.independentModes[model] !== 'off');
  }

  summary(): string {
    return this.controlMode === 'joint'
      ? `联合剖切：${modeLabel(this.jointMode)}`
      : `独立剖切：A ${modeLabel(this.independentModes.a)}，B ${modeLabel(this.independentModes.b)}`;
  }
}
