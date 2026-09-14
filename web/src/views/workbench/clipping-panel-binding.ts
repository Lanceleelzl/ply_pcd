import { h } from 'vue';
import type * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import type { ClipAxis, ClipSide } from '../../clipping-handles';
import type { GaussianDisplayController } from '../../engine/modules/GaussianDisplayController';
import ClippingPanel from './ClippingPanel.vue';
import type { InspectorState } from './inspector-state';
import type { ToolbarState } from './toolbar-state';
import { updateClippingDerivedState } from './clipping-derived-state.ts';
import { clippingPresentation } from './clipping-presentation.ts';
import type { createClippingWorkbenchState, ClippingTarget } from './clipping-workbench-state';
import type { WorkbenchViewState } from './workbench-view-state';
import { setWorkbenchHelp } from './workbench-view-state.ts';

type ClippingState = ReturnType<typeof createClippingWorkbenchState>;
interface ClippingRuntimePort {
  fit(models: ModelId[], box?: pc.Entity): void;
}

export interface ClippingPanelBindingOptions {
  inspector: InspectorState;
  toolbar: ToolbarState;
  view: WorkbenchViewState;
  clipping: ClippingState;
  runtime: ClippingRuntimePort;
  jointBox: pc.Entity;
  independentBoxes: Record<ModelId, pc.Entity>;
  gaussian: GaussianDisplayController;
  setInteractionActive(active: boolean): void;
  refreshTools(): void;
}

export function createClippingPanelBinding(options: ClippingPanelBindingOptions) {
  const { inspector, toolbar, view, clipping, runtime, jointBox, independentBoxes } = options;
  const refresh = () => {
    updateClippingDerivedState(
      { ...clipping.state, panelVisible: inspector.clipping },
      visible => { jointBox.enabled = visible; },
      (model, visible) => { independentBoxes[model].enabled = visible; },
      options.setInteractionActive,
    );
    const editedMode = clipping.state.editedMode();
    const presentation = clippingPresentation(
      clipping.state.controlMode, clipping.state.jointMode, clipping.state.independentModes, editedMode,
    );
    toolbar.clippingActive = presentation.active;
    toolbar.clippingTitle = presentation.title;
    options.gaussian.refreshStatus();
    options.refreshTools();
    setWorkbenchHelp(view, presentation.help);
  };

  const boxFor = (target: ClippingTarget) => target === 'joint' ? jointBox : independentBoxes[target];
  const render = () => h(ClippingPanel, {
    state: clipping.state, scope: clipping.settings.scope, ranges: clipping.ranges,
    onClose: () => {
      inspector.clipping = false;
      options.setInteractionActive(false);
      options.refreshTools();
    },
    onControl: (mode: Parameters<typeof clipping.setControl>[0]) => { clipping.setControl(mode); refresh(); },
    onEditor: (model: ModelId) => { clipping.setEditor(model); refresh(); },
    onMode: (target: ClippingTarget, mode: Parameters<typeof clipping.setMode>[1]) => { clipping.setMode(target, mode); refresh(); },
    onHelper: (target: ClippingTarget, visible: boolean) => { clipping.setHelper(target, visible); refresh(); },
    onScope: (scope: 'both' | ModelId) => { clipping.settings.scope = scope; refresh(); },
    onBoundary: (target: ClippingTarget, axis: ClipAxis, side: ClipSide, value: number) => clipping.setBoundary(target, axis, side, value),
    onEnabled: (target: ClippingTarget, axis: ClipAxis, side: ClipSide, value: boolean) => clipping.setEnabled(target, axis, side, value),
    onReset: clipping.reset,
    onFit: (target: ClippingTarget, models: ModelId[]) => runtime.fit(models, boxFor(target)),
    onClear: (target: ClippingTarget) => {
      clipping.clear(target);
      runtime.fit(target === 'joint' ? ['a', 'b'] : [target], boxFor(target));
      refresh();
    },
  });
  return { render, refresh };
}
