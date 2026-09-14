import { loadWorkbenchSession } from './workbench-session-loader';
import { createBusinessTransformState } from '../stores/business-transform-state';
import { createWorkbenchActivity } from '../stores/workbench-activity';
import { createRegistrationResultState } from '../stores/registration-result-state';
import { createWorkbenchSessionContext } from './workbench-session-context';
import { createGaussianViewState } from '../views/workbench/gaussian-view-state';
import type { InspectorState } from '../views/workbench/inspector-state';
import type { WorkbenchPanels } from '../views/workbench/workbench-panels';
import { createViewportToolbar } from '../views/workbench/viewport-toolbar';
import { reactive, shallowReactive, watch } from 'vue';
import * as pc from 'playcanvas';
import { RegistrationEngine } from '../engine/core/RegistrationEngine';
import { mountViewControls } from '../views/workbench/view-controls';
import { GaussianDisplayController } from '../engine/modules/GaussianDisplayController';
import type { ModelId } from '../api/contracts';
import type { WorkbenchLayoutOptions } from '../views/workbench/mount-workbench-layout';
import { createWorkbenchToolbarHandler } from '../views/workbench/workbench-toolbar-actions';
import type { ToolbarCommand } from '../views/workbench/toolbar-state';
import { createRegistrationRoleState, effectiveMovingModel } from '../views/workbench/registration-role-state';
import { createIcpParameterValues, updateIcpParameter, type IcpParameterValues } from '../views/workbench/icp-parameter-state';
import { toggleWorkbenchModelVisible } from '../views/workbench/model-visibility';
import { toggleClippingPanel as toggleClippingPanelState } from '../views/workbench/clipping-panel-toggle';
import { setOutputDirection } from '../views/workbench/output-direction-state';
import { splitCoarsePose } from '../views/workbench/coarse-pose-state';
import { formatMovingLocalToFixedLocal } from '../views/workbench/matrix-display';
import { createWorkbenchViewState } from '../views/workbench/workbench-view-state';
import { refreshWorkbenchRoles } from '../views/workbench/role-refresh';
import { bindWorkbenchFrameUpdates, createWorkbenchFrameUpdater } from './workbench-frame-updater';
import type { ResourceScope } from './resource-scope';
import { createClippingWorkbenchState } from '../views/workbench/clipping-workbench-state';
import { createWorkbenchInputDelegate } from './workbench-input-binding';
import { combinedPreviewBounds, createWorkbenchClippingRuntime } from './workbench-clipping-runtime';
import { createClippingPanelBinding } from '../views/workbench/clipping-panel-binding';
import { createWorkbenchCoordinateQuery } from './workbench-coordinate-query';
import type { CoordinateQuery } from '../engine/tools/CoordinateQuery';
import { createWorkbenchRegistrationRuntime } from './workbench-registration-runtime';
import { createWorkbenchToolRuntime } from './workbench-tool-runtime';
import { createRegistrationPanelBindings } from '../views/workbench/registration-panel-binding';
import { createWorkbenchOriginPlaneRuntime } from './workbench-origin-plane-runtime';
import { createWorkbenchCoarseRegistration } from './workbench-coarse-registration';

export interface WorkbenchHost {
  signal: AbortSignal;
  navigateHome: () => void;
  onStatus: (status: string) => void;
  mountLayout: (options: WorkbenchLayoutOptions) => Promise<void>;
}

export async function initializeWorkbench(
  root: HTMLElement,
  sessionId: string,
  signal: AbortSignal,
  resources: ResourceScope,
  host: WorkbenchHost,
): Promise<void> {
  const loaded = await loadWorkbenchSession(sessionId, signal, host.onStatus);
  const { session } = loaded;
  const cloudA = loaded.previews.a;
  const cloudB = loaded.previews.b;
  const context = createWorkbenchSessionContext(session);
  const origins = context.origins;
  const businessTransforms = context.businessTransforms;
  const gaussianState = createGaussianViewState();
  const queryToolbar = createViewportToolbar();
  const panels = shallowReactive<WorkbenchPanels>({});
  const inspectorState = reactive<InspectorState>({ clipping: false, originPlanes: false, query: false });
  const toolbarState = queryToolbar.state;
  const results = createRegistrationResultState();
  const resultState = results.state;
  const viewState = reactive(createWorkbenchViewState());
  let toolbarHandler: (command: ToolbarCommand) => void = () => {};
  await host.mountLayout({
    view: viewState, onNewTask: host.navigateHome,
    session, gaussian: gaussianState, toolbar: toolbarState, result: resultState, inspector: inspectorState, panels,
    onToolbar: command => toolbarHandler(command),
  });
  signal.throwIfAborted();

  const activity = createWorkbenchActivity();
  const activityState = activity.state;
  const roleState = reactive(createRegistrationRoleState(session));
  const effectiveMoving = (): ModelId => effectiveMovingModel(roleState.moving, session.metadata!.recommended_moving_model);


  const canvas = root.querySelector<HTMLCanvasElement>('#viewport')!;
  const viewportElement = canvas.parentElement!;
  viewportElement.style.minHeight = '0';
  viewportElement.style.overflow = 'hidden';
  const viewControls = mountViewControls(root, {
    direction: value => engine.cameraController.setViewDirection(new pc.Vec3(...value)),
    orbit: (horizontal, vertical) => engine.cameraController.orbit(horizontal, vertical),
    projection: orthographic => engine.cameraController.setProjection(orthographic),
  });
  resources.add(() => viewControls.destroy());
  const engine = new RegistrationEngine({
    canvas, orientationChanged: viewControls.update, clouds: { a: cloudA, b: cloudB },
    origins,
    transforms: businessTransforms, moving: effectiveMoving(),
  });
  resources.add(() => engine.destroy());
  const { app: application, camera, scene, cameraController, translate, rotate, clipTranslate, clipRotate, tools: toolManager } = engine;
  const { entities, clouds, pointMaterials, clipBox, independentClipBoxes, display, modelDiagonals } = scene;
  const modelVisible = toolbarState.visible;
  let clippingInteractionActive = false;
  let coordinateQuery: CoordinateQuery | null = null;
  const originPlaneRuntime = createWorkbenchOriginPlaneRuntime({
    root, inspector: inspectorState, toolbar: toolbarState, app: application,
    entities, origins, modelDiagonals, modelVisible,
    closeConflicts: () => {
      clippingInteractionActive = false;
      if (coordinateQuery?.active) coordinateQuery.close();
    },
    refreshTools: () => attach(),
  });
  panels.originPlanes = originPlaneRuntime.render;
  const originPlanes = originPlaneRuntime.controller;
  resources.add(originPlaneRuntime.destroy);
  toolbarHandler = createWorkbenchToolbarHandler({
    reset: () => { if (!toolbarState.locked) display.reset(effectiveMoving()); },
    fit: () => cameraController.fit(),
    toggleClipping: () => toggleClippingPanel(),
    toggleOriginPlanes: originPlaneRuntime.toggle,
    toggleQuery: () => coordinateQuery?.toggleQuery(),
    setModelVisible: model => toggleWorkbenchModelVisible(model, modelVisible, entities, attach),
    toggleOrigin: model => {
      const active = coordinateQuery?.toggleOrigin(model) ?? false;
      toolbarState.axes[model] = active;
      return active;
    },
    toggleGaussian: model => { void gaussianController.toggle(model); },
  });
  const originalBounds = combinedPreviewBounds({ a: cloudA, b: cloudB });
  const clipping = createClippingWorkbenchState(originalBounds);
  const { state: clippingState } = clipping;
  let syncClipping = (_force = false) => {};
  const applyHandle = () => display.applyHandle();
  const toolRuntime = createWorkbenchToolRuntime({
    manager: toolManager, translate, rotate, clipTranslate, clipRotate,
    handle: display.handle, entities, modelVisible, effectiveMoving,
    activeClipBox: () => clippingState.controlMode === 'joint' ? clipBox : independentClipBoxes[clippingState.editor],
    clippingEnabled: () => clippingState.enabled(),
    clippingHelperVisible: () => clippingState.helperVisible(),
    editedClippingMode: () => clippingState.editedMode(),
    clippingInteractionActive: () => clippingInteractionActive,
    queryActive: () => activityState.queryActive,
    running: () => activityState.running,
    query: () => coordinateQuery,
    applyHandle,
  });
  resources.add(toolRuntime.destroy);
  const attach = toolRuntime.refresh;

  const gaussianController = new GaussianDisplayController({
    app: application,
    entities,
    urls: context.gaussianUrls,
    origins,
    clippingEnabled: () => clippingState.enabled()
      || (['a', 'b'] as ModelId[]).some(model => originPlanes.clipSides(model).lengthSq() > 0),
    clipStateChanged: () => syncClipping(true),
    presentationChanged: attach,
    displayChanged: (model, state) => { gaussianState.models[model] = state; },
    statusChanged: (message, error) => { gaussianState.message = message; gaussianState.error = error; },
  });
  resources.add(() => gaussianController.destroy());
  resources.add(originPlaneRuntime.bindStatusRefresh(() => gaussianController.refreshStatus()));

  const poseState = shallowReactive({ values: [0, 0, 0, 0, 0, 0] });
  let markCoarseAdjusted = () => {};
  let resetCoarse = () => {};

  const refreshRoles = (reset = false) => {
    const moving = effectiveMoving();
    refreshWorkbenchRoles(entities, moving, () => { if (reset) display.reset(moving); }, summary => { viewState.roleSummary = summary; }, attach);
  };
  refreshRoles();

  const business = createBusinessTransformState(sessionId, businessTransforms, signal, next => {
    resetCoarse();
    businessTransforms.a = next.a; businessTransforms.b = next.b; refreshRoles(true);
    coordinateQuery?.invalidate(); results.hide();
  });
  const { drafts: businessDraft, state: businessState } = business;
  resources.add(watch(() => activityState.editingLocked, locked => {
    businessState.disabled = locked;
    toolbarState.locked = locked;
  }, { flush: 'sync', immediate: true }));

  const clippingRuntime = createWorkbenchClippingRuntime({
    app: application, camera, canvas, viewport: viewportElement,
    clouds, entities, jointBox: clipBox, independentBoxes: independentClipBoxes,
    pointMaterials, clipping, gaussian: gaussianController, originPlanes,
    queryActive: () => activityState.queryActive,
    interactionActive: () => clippingInteractionActive,
    interactionChanged: toolRuntime.setGizmoTransforming,
  });
  syncClipping = force => clippingRuntime.scene.sync(force);
  resources.add(clippingRuntime.destroy);
  resources.add(bindWorkbenchFrameUpdates(application, createWorkbenchFrameUpdater({
    invalidateResult: () => results.invalidateIfChanged(display.signature()),
    readPose: () => { const pose = display.getPose(); return [new pc.Vec3(...pose.position), new pc.Vec3(...pose.rotation)]; },
    updatePose: values => {
      if (values.some((value, index) => value !== poseState.values[index])) {
        poseState.values = values;
        markCoarseAdjusted();
      }
    },
    readMatrix: () => formatMovingLocalToFixedLocal(display.getMovingLocalToFixedLocal()),
    updateMatrix: value => { viewState.initialMatrix = value; },
    syncClipping: () => clippingRuntime.scene.sync(),
    updateClippingHandles: clippingRuntime.update,
  })));

  const clippingPanel = root.querySelector<HTMLElement>('#clipping-panel')!;
  const clippingPanelBinding = createClippingPanelBinding({
    inspector: inspectorState, toolbar: toolbarState, view: viewState,
    clipping, runtime: clippingRuntime, jointBox: clipBox, independentBoxes: independentClipBoxes,
    gaussian: gaussianController,
    setInteractionActive: active => { clippingInteractionActive = active; },
    refreshTools: attach,
  });
  const toggleClippingPanel = () => {
    toggleClippingPanelState(inspectorState, () => {
      clippingPanel.parentElement!.scrollTop = 0;
    }, () => { clippingInteractionActive = false; });
    clippingPanelBinding.refresh();
  };
  panels.clipping = clippingPanelBinding.render;
  clippingPanelBinding.refresh();

  engine.bindInput(createWorkbenchInputDelegate({
    canvas, clipping: () => clippingRuntime.handles, query: () => coordinateQuery,
    clippingInteractionActive: () => clippingInteractionActive,
    movingGizmoHovered: () => toolRuntime.movingInput.hovered,
    clippingGizmoHovered: () => toolRuntime.clippingInput.hovered,
    gizmoTransforming: toolRuntime.gizmoTransforming,
    syncClipping: () => clippingRuntime.scene.sync(true),
  }));

  const icpValues = reactive<IcpParameterValues>(createIcpParameterValues());
  const setRunning = (value: boolean) => {
    activity.setRunning(value);
    attach();
  };
  const queryRuntime = createWorkbenchCoordinateQuery({
    root, inspector: inspectorState, toolbar: queryToolbar, activity: activityState,
    app: application, camera, canvas, entities, clouds, sessionId,
    origins, businessMatrices: display.businessMatrices, diagonal: scene.baseDiagonal,
    localToDisplay: model => display.localToDisplay(model),
    signature: () => display.signature(),
    setOriginal: original => { display.setOriginal(original); cameraController.fit(); },
    setClippingInteractionActive: active => { clippingInteractionActive = active; },
    refreshTools: attach,
    visiblePoint: (model, point) => {
      if (!originPlanes.visiblePoint(model, point)) return false;
      return clippingRuntime.scene.visiblePoint(model, point);
    },
  });
  coordinateQuery = queryRuntime.controller;
  panels.query = queryRuntime.render;
  resources.add(queryRuntime.destroy);
  let coarseInitialSource: () => 'manual' | '4pcs' | '4pcs_adjusted' = () => 'manual';
  const registrationRuntime = createWorkbenchRegistrationRuntime({
    sessionId, registrations: session.registrations, signal, activity, results,
    role: roleState, icp: icpValues, display, query: () => coordinateQuery,
    runningChanged: setRunning, refreshRoles, fitCamera: () => cameraController.fit(),
    initialSource: () => coarseInitialSource(),
  });
  resources.add(registrationRuntime.destroy);
  const coarseRuntime = createWorkbenchCoarseRegistration({
    sessionId, signal, display,
    movingModel: () => effectiveMovingModel(roleState.moving, session.metadata!.recommended_moving_model),
    setRunning,
    updatePose: values => { poseState.values = values; },
    invalidateResult: () => { coordinateQuery?.invalidate(); results.hide(); },
    fitCamera: () => cameraController.fit(),
  });
  coarseInitialSource = coarseRuntime.initialSource;
  markCoarseAdjusted = coarseRuntime.markAdjusted;
  resetCoarse = coarseRuntime.reset;
  resources.add(coarseRuntime.destroy);
  Object.assign(panels, createRegistrationPanelBindings({
    activity: activityState, role: roleState,
    recommendedMoving: session.metadata!.recommended_moving_model, modelDiagonals,
    pose: poseState, coarse: coarseRuntime, business, icp: icpValues, actions: registrationRuntime.actions,
    changePose: values => {
      const pose = splitCoarsePose(values);
      display.setPose(pose.position, pose.rotation);
      coarseRuntime.markAdjusted();
    },
    changeMoving: value => { coarseRuntime.reset(); roleState.moving = value; coordinateQuery?.invalidate(); refreshRoles(true); },
    changeDirection: value => setOutputDirection(roleState, value, results.hide, () => coordinateQuery?.invalidate()),
    changeBusiness: (model, kind, index, value) => { businessDraft[model][kind][index] = value; },
    changeIcp: (key, value) => updateIcpParameter(icpValues, key, value),
  }));
  await registrationRuntime.restore();
}
