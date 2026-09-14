import type * as pc from 'playcanvas';
import type { ToolManager } from '../../engine/core/ToolManager';
import type { WorkbenchToolId } from './workbench-tool-routing';

export interface WorkbenchToolRegistrationOptions {
  manager: ToolManager<WorkbenchToolId>;
  translate: pc.TransformGizmo;
  rotate: pc.TransformGizmo;
  clipTranslate: pc.TransformGizmo;
  clipRotate: pc.TransformGizmo;
  handle: pc.Entity;
  activeClipBox: () => pc.Entity;
  clippingActive: () => boolean;
  helperVisible: () => boolean;
  editedMode: () => string;
}

export function registerWorkbenchTools(options: WorkbenchToolRegistrationOptions): void {
  const { manager, translate, rotate, clipTranslate, clipRotate } = options;
  manager.register({ id: 'idle', activate: () => {}, deactivate: () => {} });
  manager.register({
    id: 'model-transform',
    activate: () => { translate.attach(options.handle); rotate.attach(options.handle); },
    deactivate: () => { translate.detach(); rotate.detach(); },
  });
  manager.register({
    id: 'clipping',
    activate: () => {
      if (options.editedMode() === 'box' && options.clippingActive() && options.helperVisible()) {
        const box = options.activeClipBox();
        clipTranslate.attach(box); clipRotate.attach(box);
      } else {
        clipTranslate.detach(); clipRotate.detach();
      }
    },
    deactivate: () => { clipTranslate.detach(); clipRotate.detach(); },
  });
  manager.register({ id: 'coordinate-query', activate: () => {}, deactivate: () => {} });
}
