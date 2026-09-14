import * as pc from 'playcanvas';
import type { ModelId } from '../api/contracts';
import { TransformGizmoInput } from '../engine/core/TransformGizmoInput.ts';
import type { ToolManager } from '../engine/core/ToolManager';
import { registerWorkbenchTools } from '../views/workbench/workbench-tool-registration.ts';
import { isMovingModelVisible, resolveWorkbenchTool } from '../views/workbench/workbench-tool-routing.ts';
import type { WorkbenchToolId } from '../views/workbench/workbench-tool-routing.ts';

interface QueryToolPort {
  setClippingActive(active: boolean): void;
}

export interface WorkbenchToolRuntimeOptions {
  manager: ToolManager<WorkbenchToolId>;
  translate: pc.TranslateGizmo;
  rotate: pc.RotateGizmo;
  clipTranslate: pc.TranslateGizmo;
  clipRotate: pc.RotateGizmo;
  handle: pc.Entity;
  entities: Record<ModelId, pc.Entity>;
  modelVisible: Record<ModelId, boolean>;
  effectiveMoving(): ModelId;
  activeClipBox(): pc.Entity;
  clippingEnabled(): boolean;
  clippingHelperVisible(): boolean;
  editedClippingMode(): 'off' | 'axis' | 'box';
  clippingInteractionActive(): boolean;
  queryActive(): boolean;
  running(): boolean;
  query(): QueryToolPort | null;
  applyHandle(): void;
}

export function createWorkbenchToolRuntime(options: WorkbenchToolRuntimeOptions) {
  let gizmoTransforming = false;
  const setGizmoTransforming = (active: boolean) => { gizmoTransforming = active; };
  const movingInput = new TransformGizmoInput(options.translate, options.rotate, setGizmoTransforming);
  const clippingInput = new TransformGizmoInput(options.clipTranslate, options.clipRotate, setGizmoTransforming);
  [options.translate, options.rotate].forEach(gizmo => {
    gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, options.applyHandle);
  });
  registerWorkbenchTools({
    manager: options.manager,
    translate: options.translate,
    rotate: options.rotate,
    clipTranslate: options.clipTranslate,
    clipRotate: options.clipRotate,
    handle: options.handle,
    activeClipBox: options.activeClipBox,
    clippingActive: options.clippingEnabled,
    helperVisible: options.clippingHelperVisible,
    editedMode: options.editedClippingMode,
  });
  const refresh = () => {
    const clippingInteractionActive = options.clippingInteractionActive();
    options.query()?.setClippingActive(clippingInteractionActive);
    options.manager.activate(resolveWorkbenchTool({
      clippingInteractionActive,
      queryActive: options.queryActive(),
      running: options.running(),
      movingVisible: isMovingModelVisible(options.modelVisible, options.effectiveMoving()),
    }));
  };
  return {
    movingInput,
    clippingInput,
    refresh,
    setGizmoTransforming,
    gizmoTransforming: () => gizmoTransforming,
    destroy() {
      movingInput.destroy();
      clippingInput.destroy();
      options.translate.off(pc.TransformGizmo.EVENT_TRANSFORMMOVE, options.applyHandle);
      options.rotate.off(pc.TransformGizmo.EVENT_TRANSFORMMOVE, options.applyHandle);
    },
  };
}
