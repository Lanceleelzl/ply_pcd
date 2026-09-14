import { watch } from 'vue';
import * as pc from 'playcanvas';
import type { ModelId } from '../api/contracts';
import type { XYZ } from '../coordinate-math';
import { OriginPlaneController } from '../origin-planes';
import type { InspectorState } from '../views/workbench/inspector-state';
import { applyOriginPlaneVisibility } from '../views/workbench/origin-plane-lifecycle';
import { createOriginPlanePanel } from '../views/workbench/origin-plane-panel';
import type { ToolbarState } from '../views/workbench/toolbar-state';

interface WorkbenchOriginPlaneRuntimeOptions {
  root: HTMLElement;
  inspector: InspectorState;
  toolbar: ToolbarState;
  app: pc.Application;
  entities: Record<ModelId, pc.Entity>;
  origins: Record<ModelId, XYZ>;
  modelDiagonals: Record<ModelId, number>;
  modelVisible: Record<ModelId, boolean>;
  closeConflicts(): void;
  refreshTools(): void;
}

export function createWorkbenchOriginPlaneRuntime(options: WorkbenchOriginPlaneRuntimeOptions) {
  const panel = createOriginPlanePanel(options.root, options.inspector, active => {
    options.toolbar.originPlanesActive = active;
  });
  const controller = new OriginPlaneController(
    options.app,
    options.entities,
    options.origins,
    options.modelDiagonals,
    options.modelVisible,
    panel.state,
  );
  return {
    controller,
    render: panel.render,
    toggle() {
      panel.toggle();
      applyOriginPlaneVisibility(
        options.inspector,
        options.inspector.originPlanes,
        options.closeConflicts,
        options.refreshTools,
        active => { options.toolbar.originPlanesActive = active; },
      );
    },
    bindStatusRefresh(refresh: () => void) {
      return watch(panel.state, refresh);
    },
    destroy() {
      controller.destroy();
    },
  };
}
