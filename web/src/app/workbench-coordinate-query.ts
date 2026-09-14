import * as pc from 'playcanvas';
import type { ModelId } from '../api/contracts';
import type { Matrix, XYZ } from '../coordinate-math';
import type { PreviewCloud } from '../point-cloud';
import { CoordinateQuery } from '../engine/tools/CoordinateQuery.ts';
import type { createWorkbenchActivity } from '../stores/workbench-activity';
import type { InspectorState } from '../views/workbench/inspector-state';
import { applyCoordinateQueryLock } from '../views/workbench/coordinate-query-lifecycle.ts';
import { createCoordinateQueryViews } from '../views/workbench/coordinate-query-views.ts';
import type { createViewportToolbar } from '../views/workbench/viewport-toolbar';

type ActivityState = ReturnType<typeof createWorkbenchActivity>['state'];
type QueryToolbar = ReturnType<typeof createViewportToolbar>;

export interface WorkbenchCoordinateQueryOptions {
  root: HTMLElement;
  inspector: InspectorState;
  toolbar: QueryToolbar;
  activity: ActivityState;
  app: pc.Application;
  camera: pc.Entity;
  canvas: HTMLCanvasElement;
  entities: Record<ModelId, pc.Entity>;
  clouds: Record<ModelId, PreviewCloud>;
  sessionId: string;
  origins: Record<ModelId, XYZ>;
  businessMatrices: Record<ModelId, Matrix>;
  diagonal: number;
  localToDisplay(model: ModelId): Matrix;
  signature(): string;
  setOriginal(original: boolean): void;
  setClippingInteractionActive(active: boolean): void;
  refreshTools(): void;
  visiblePoint(model: ModelId, point: pc.Vec3): boolean;
}

export function createWorkbenchCoordinateQuery(options: WorkbenchCoordinateQueryOptions) {
  let query: CoordinateQuery | null = null;
  const views = createCoordinateQueryViews(options.root, options.inspector, {
    onSource: model => query?.setSource(model),
    onChange: values => query?.setCoordinates(values),
    onInvalid: () => query?.handlePanelAction('invalid'),
    onAction: action => query?.handlePanelAction(action),
  });
  query = new CoordinateQuery({
    labels: views.labels, panel: views.panel, toolbar: options.toolbar,
    app: options.app, camera: options.camera, canvas: options.canvas,
    entities: options.entities, clouds: options.clouds, sessionId: options.sessionId,
    origins: options.origins, businessMatrices: options.businessMatrices, diagonal: options.diagonal,
    localToDisplay: options.localToDisplay, signature: options.signature,
    setOriginal: options.setOriginal,
    lock: active => applyCoordinateQueryLock(options.activity, active, () => {
      options.inspector.clipping = false;
      options.inspector.originPlanes = false;
    }, () => options.setClippingInteractionActive(false), options.refreshTools),
    visiblePoint: options.visiblePoint,
  });
  const controller = query;
  return {
    controller,
    render: views.panel.render,
    destroy() { controller.destroy(); views.destroy(); },
  };
}
