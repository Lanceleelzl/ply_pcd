import * as pc from 'playcanvas';
import type { ModelId } from '../api/contracts';
import { ClippingHandles } from '../clipping-handles.ts';
import type { PointCloudMaterial } from '../point-cloud';
import type { GaussianDisplayController } from '../engine/modules/GaussianDisplayController';
import { ClippingSceneController } from '../engine/modules/ClippingSceneController.ts';
import { fitClipBox, worldBounds } from '../views/workbench/clip-box-fitting.ts';
import { mountClippingLabels } from '../views/workbench/clipping-labels.ts';
import { clippingHandleMode } from '../views/workbench/clipping-interaction-state.ts';
import type { createClippingWorkbenchState } from '../views/workbench/clipping-workbench-state';

type ClippingState = ReturnType<typeof createClippingWorkbenchState>;

interface CloudBounds {
  min: pc.Vec3;
  max: pc.Vec3;
}

export function combinedPreviewBounds(clouds: Record<ModelId, CloudBounds>) {
  return {
    min: new pc.Vec3(
      Math.min(clouds.a.min.x, clouds.b.min.x),
      Math.min(clouds.a.min.y, clouds.b.min.y),
      Math.min(clouds.a.min.z, clouds.b.min.z),
    ),
    max: new pc.Vec3(
      Math.max(clouds.a.max.x, clouds.b.max.x),
      Math.max(clouds.a.max.y, clouds.b.max.y),
      Math.max(clouds.a.max.z, clouds.b.max.z),
    ),
  };
}

export interface WorkbenchClippingRuntimeOptions {
  app: pc.Application;
  camera: pc.Entity;
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  clouds: Record<ModelId, CloudBounds>;
  entities: Record<ModelId, pc.Entity>;
  jointBox: pc.Entity;
  independentBoxes: Record<ModelId, pc.Entity>;
  pointMaterials: Record<ModelId, PointCloudMaterial>;
  clipping: ClippingState;
  gaussian: GaussianDisplayController;
  originPlanes: {
    clipSides(model: ModelId): pc.Vec3;
    getWorldToOrigin(model: ModelId): pc.Mat4;
  };
  queryActive(): boolean;
  interactionActive(): boolean;
  interactionChanged(active: boolean): void;
}

export function createWorkbenchClippingRuntime(options: WorkbenchClippingRuntimeOptions) {
  const { clipping, jointBox, independentBoxes } = options;
  const bounds = combinedPreviewBounds(options.clouds);
  const scene = new ClippingSceneController({
    app: options.app,
    state: clipping.state,
    jointBox,
    independentBoxes,
    pointMaterials: options.pointMaterials,
    gaussian: options.gaussian,
    scope: () => clipping.settings.scope,
    axisState: model => clipping.axisState(clipping.state.controlMode === 'joint' ? 'joint' : model),
    originState: model => ({
      sides: options.originPlanes.clipSides(model),
      worldToOrigin: options.originPlanes.getWorldToOrigin(model),
    }),
  });
  const labels = mountClippingLabels(options.viewport);
  const handles = new ClippingHandles(
    options.app, options.camera, options.canvas,
    () => clipping.state.controlMode === 'joint' ? jointBox : independentBoxes[clipping.state.editor],
    bounds.min, bounds.max,
    () => clippingHandleMode(options.queryActive(), options.interactionActive(), clipping.state.editedMode()),
    () => clipping.axisState(clipping.activeTarget()),
    (axis, side, value) => clipping.setBoundary(clipping.activeTarget(), axis, side, value),
    () => clipping.state.helperVisible(), options.interactionChanged, labels,
  );
  const fit = (models: ModelId[], box = jointBox) => {
    fitClipBox(box, worldBounds(models, {
      a: { ...options.clouds.a, transform: options.entities.a.getWorldTransform() },
      b: { ...options.clouds.b, transform: options.entities.b.getWorldTransform() },
    }));
  };
  fit(['a', 'b']);
  fit(['a'], independentBoxes.a);
  fit(['b'], independentBoxes.b);
  return {
    scene, handles, fit,
    update() { scene.drawHelpers(); handles.update(); },
    destroy() { handles.destroy(); labels.destroy(); },
  };
}
