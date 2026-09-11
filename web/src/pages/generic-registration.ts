import { waitForSession } from '../api/registration-api';
import { ResourceScope } from '../app/resource-scope';
import type { GaussianViewState } from '../views/workbench/gaussian-view-state';
import type { ResultViewState } from '../views/workbench/result-view-state';
import type { InspectorState } from '../views/workbench/inspector-state';
import type { WorkbenchPanels } from '../views/workbench/workbench-panels';
import RegistrationRoles from '../views/workbench/RegistrationRoles.vue';
import ClippingPanel from '../views/workbench/ClippingPanel.vue';
import { createAxisRange, setAxisRangeBoundary, type AxisRangeState } from '../engine/modules/axis-range';
import { mountCoordinateLabels } from '../views/workbench/coordinate-labels';
import { mountClippingLabels } from '../views/workbench/clipping-labels';
import { createCoordinatePanel } from '../views/workbench/coordinate-fields';
import { createViewportToolbar } from '../views/workbench/viewport-toolbar';
import BusinessTransformPanel from '../views/workbench/BusinessTransformPanel.vue';
import CoarsePoseForm from '../views/workbench/CoarsePoseForm.vue';
import RegistrationActions from '../views/workbench/RegistrationActions.vue';
import IcpParameters from '../views/workbench/IcpParameters.vue';
import { h, reactive, shallowReactive, watch } from 'vue';
import * as pc from 'playcanvas';
import { CoordinateQuery } from '../engine/tools/CoordinateQuery';
import { transformParametersMatrix, transformXYZ, type TransformParameters, type XYZ } from '../coordinate-math';
import { ClippingHandles, type ClipAxis, type ClipSide } from '../clipping-handles';
import { OriginPlaneController } from '../origin-planes';
import { createOriginPlanePanel } from '../views/workbench/origin-plane-panel';
import { loadPreview, type PointCloudMaterial } from '../point-cloud';
import '../workspace.css';
import '../view-gizmo.css';
import { RegistrationEngine } from '../engine/core/RegistrationEngine';
import { mountViewControls } from '../views/workbench/view-controls';
import { TransformGizmoInput } from '../engine/core/TransformGizmoInput';
import { RegistrationJobController } from '../engine/modules/RegistrationJobController';
import { GaussianDisplayController } from '../engine/modules/GaussianDisplayController';
import { ClippingStateController, type ClippingMode, type ClippingControlMode } from '../engine/modules/ClippingStateController';
import { ClippingSceneController } from '../engine/modules/ClippingSceneController';
import type {
  Matrix4,
  ModelId,
  RegistrationIteration,
  RegistrationRequest,
  RegistrationResult,
} from '../api/contracts';
import type { WorkbenchLayoutOptions } from '../views/workbench/mount-workbench-layout';

const matrixText = (matrix: Matrix4) => matrix.map(row => row.map(value => value.toFixed(12)).join(' ')).join('\n');

export async function renderGenericRegistration(
  root: HTMLElement,
  sessionId: string,
  host: {
    signal: AbortSignal;
    navigateHome: () => void;
    onStatus: (status: string) => void;
    mountLayout: (options: WorkbenchLayoutOptions) => Promise<void>;
  },
): Promise<() => void> {
  const externalSignal = host.signal;
  externalSignal?.throwIfAborted();
  const lifecycle = new AbortController();
  const resources = new ResourceScope();
  const dispose = () => {
    lifecycle.abort();
    externalSignal?.removeEventListener('abort', dispose);
    try { resources.dispose(); } catch (error) { console.error(error); }
  };
  externalSignal?.addEventListener('abort', dispose, { once: true });
  const { signal } = lifecycle;
  try {
    await initializeWorkbench(root, sessionId, signal, resources, host);
    signal.throwIfAborted();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

async function initializeWorkbench(
  root: HTMLElement,
  sessionId: string,
  signal: AbortSignal,
  resources: ResourceScope,
  host: Parameters<typeof renderGenericRegistration>[2],
): Promise<void> {
  const session = await waitForSession(sessionId, signal, host.onStatus);
  const [cloudA, cloudB] = await Promise.all([
    loadPreview(session.model_a_preview_url!, signal), loadPreview(session.model_b_preview_url!, signal),
  ]);
  signal.throwIfAborted();
  const infoA = session.metadata!.models.a;
  const infoB = session.metadata!.models.b;
  const defaultTransform = (): TransformParameters => ({ translation: [0,0,0], rotation_degrees: [0,0,0], scale: [1,1,1] });
  const businessTransforms: Record<ModelId, TransformParameters> = session.business_transforms ?? { a: defaultTransform(), b: defaultTransform() };
  const gaussianState = reactive<GaussianViewState>({
    models: { a: { active: false, loading: false }, b: { active: false, loading: false } },
    message: '', error: false,
  });
  const queryToolbar = createViewportToolbar();
  const panels = shallowReactive<WorkbenchPanels>({});
  const inspectorState = reactive<InspectorState>({ clipping: false, originPlanes: false, query: false });
  const toolbarState = queryToolbar.state;
  const resultState = shallowReactive<ResultViewState>({
    result: null, direction: 'a_to_b', visible: false, status: '尚未提交',
    progressVisible: false, progressCompleted: false, progressText: '', progressTop: 0,
  });
  const viewState = reactive({ roleSummary: '', initialMatrix: '', help: '' });
  await host.mountLayout({
    view: viewState, onNewTask: host.navigateHome,
    session, gaussian: gaussianState, toolbar: toolbarState, result: resultState, inspector: inspectorState, panels,
    onToolbar: command => {
      switch (command.type) {
        case 'reset': if (!toolbarState.locked) display.reset(effectiveMoving()); break;
        case 'fit': cameraController.fit(); break;
        case 'clipping': toggleClippingPanel(); break;
        case 'origin-planes': toggleOriginPlanes(); break;
        case 'query': coordinateQuery?.toggleQuery(); break;
        case 'visibility': setModelVisible(command.model, !modelVisible[command.model]); break;
        case 'origin-axes': toolbarState.axes[command.model] = coordinateQuery?.toggleOrigin(command.model) ?? false; break;
        case 'gaussian': void gaussianController.toggle(command.model); break;
      }
    },
  });
  signal.throwIfAborted();

  const roleState = reactive({ moving: session.moving_model, direction: session.output_direction, disabled: false });
  const effectiveMoving = (): ModelId => roleState.moving === 'auto'
    ? session.metadata!.recommended_moving_model : roleState.moving;


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
    origins: { a: infoA.origin as XYZ, b: infoB.origin as XYZ },
    transforms: businessTransforms, moving: effectiveMoving(),
  });
  resources.add(() => engine.destroy());
  const { app: application, camera, scene, cameraController, translate, rotate, clipTranslate, clipRotate, tools: toolManager } = engine;
  const { entities, clouds, pointMaterials, clipBox, independentClipBoxes, display, modelDiagonals } = scene;
  const modelVisible = toolbarState.visible;
  const originPlaneUI = createOriginPlanePanel(root, inspectorState, active => { toolbarState.originPlanesActive = active; });
  panels.originPlanes = originPlaneUI.render;
  const originPlanes = new OriginPlaneController(application, entities,
    { a: infoA.origin as XYZ, b: infoB.origin as XYZ }, modelDiagonals, modelVisible, originPlaneUI.state);
  resources.add(() => originPlanes.destroy());
  const clippingState = reactive(new ClippingStateController());
  let clippingScene: ClippingSceneController | null = null;
  let clippingInteractionActive = false;
  let running = false;
  let queryActive = false;
  let coordinateQuery: CoordinateQuery | null = null;
  let resultSignature = '';
  let gizmoTransforming = false;
  const movingGizmoInput = new TransformGizmoInput(translate, rotate, active => { gizmoTransforming = active; });
  resources.add(() => movingGizmoInput.destroy());
  const clipGizmoInput = new TransformGizmoInput(clipTranslate, clipRotate, active => { gizmoTransforming = active; });
  resources.add(() => clipGizmoInput.destroy());
  const movingEntity = () => entities[effectiveMoving()];
  [translate, rotate].forEach(gizmo => gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => display.applyHandle()));
  toolManager.register({
    id: 'idle',
    activate: () => {},
    deactivate: () => {},
  });
  toolManager.register({
    id: 'model-transform',
    activate: () => { translate.attach(display.handle); rotate.attach(display.handle); },
    deactivate: () => { translate.detach(); rotate.detach(); },
  });
  toolManager.register({
    id: 'clipping',
    activate: () => {
      const activeMode = clippingState.editedMode();
      const helperVisible = clippingState.helperVisible();
      const activeBox = clippingState.controlMode === 'joint' ? clipBox : independentClipBoxes[clippingState.editor];
      if (activeMode === 'box' && helperVisible) {
        clipTranslate.attach(activeBox);
        clipRotate.attach(activeBox);
      } else {
        clipTranslate.detach();
        clipRotate.detach();
      }
    },
    deactivate: () => { clipTranslate.detach(); clipRotate.detach(); },
  });
  toolManager.register({
    id: 'coordinate-query',
    activate: () => {},
    deactivate: () => {},
  });
  const attach = () => {
    coordinateQuery?.setClippingActive(clippingInteractionActive);
    if (clippingInteractionActive) toolManager.activate('clipping');
    else if (queryActive) toolManager.activate('coordinate-query');
    else if (!running && modelVisible[effectiveMoving()]) toolManager.activate('model-transform');
    else toolManager.activate('idle');
  };

  const setModelVisible = (model: ModelId, visible: boolean) => {
    modelVisible[model] = visible;
    entities[model].enabled = visible;
    attach();
  };

  const gaussianController = new GaussianDisplayController({
    app: application,
    entities,
    urls: { a: session.gaussian_a_url, b: session.gaussian_b_url },
    origins: { a: infoA.origin as XYZ, b: infoB.origin as XYZ },
    clippingEnabled: () => clippingState.enabled()
      || (['a', 'b'] as ModelId[]).some(model => originPlanes.clipSides(model).lengthSq() > 0),
    clipStateChanged: () => clippingScene?.sync(true),
    presentationChanged: attach,
    displayChanged: (model, state) => { gaussianState.models[model] = state; },
    statusChanged: (message, error) => { gaussianState.message = message; gaussianState.error = error; },
  });
  resources.add(() => gaussianController.destroy());
  resources.add(watch(originPlaneUI.state, () => gaussianController.refreshStatus()));

  const poseState = shallowReactive({ values: [0, 0, 0, 0, 0, 0], disabled: false });
  panels.pose = () => h(CoarsePoseForm, {
    ...poseState,
    onChange: (values: number[]) => {
      display.setPose(values.slice(0, 3) as XYZ, values.slice(3) as XYZ);
    },
  });

  const refreshRoles = (reset = false) => {
    const moving = effectiveMoving(); const fixed = moving === 'a' ? 'b' : 'a';
    if (reset) display.reset(moving);
    const recolor = (entity: pc.Entity, color: pc.Color) => entity.render!.meshInstances.forEach(instance => {
      (instance.material as PointCloudMaterial).setPointColor(color);
    });
    recolor(entities[moving], new pc.Color(1.0, 0.72, 0.08));
    recolor(entities[fixed], new pc.Color(0.68, 0.72, 0.78));
    viewState.roleSummary = `移动 ${moving.toUpperCase()}（黄色）　固定 ${fixed.toUpperCase()}（灰色）`;
    attach();
  };
  panels.roles = () => h(RegistrationRoles, {
    ...roleState, recommended: session.metadata!.recommended_moving_model, diagonals: modelDiagonals,
    onMoving: (value: RegistrationRequest['moving_model']) => { roleState.moving = value; coordinateQuery?.invalidate(); refreshRoles(true); },
    onDirection: (value: RegistrationRequest['output_direction']) => { roleState.direction = value; resultState.visible = false; },
  });
  refreshRoles();

  const toDraft = (value: TransformParameters) => ({
    translation: value.translation.map(String), rotation_degrees: value.rotation_degrees.map(String), scale: value.scale.map(String),
  });
  const businessDraft = reactive({ a: toDraft(businessTransforms.a), b: toDraft(businessTransforms.b) });
  const businessState = shallowReactive({ disabled: false, saving: false, message: '' });
  const readBusinessTransform = (model: ModelId): TransformParameters => {
    const values = (kind: keyof TransformParameters) => businessDraft[model][kind].map(value =>
      value.trim() === '' ? (kind === 'scale' ? 1 : 0) : Number(value)) as XYZ;
    return { translation: values('translation'), rotation_degrees: values('rotation_degrees'), scale: values('scale') };
  };
  const setBusinessInputs = (model: ModelId, value: TransformParameters) => { businessDraft[model] = toDraft(value); };
  const applyBusinessTransforms = async () => {
    if (businessState.disabled || businessState.saving) return;
    businessState.saving = true;
    try {
      const next = { a: readBusinessTransform('a'), b: readBusinessTransform('b') };
      for (const value of Object.values(next)) {
        if ([...value.translation,...value.rotation_degrees,...value.scale].some(number => !Number.isFinite(number))) throw new Error('参数必须是有效数字');
        if (value.scale.some(number => number <= 0)) throw new Error('缩放必须大于 0');
      }
      const response = await fetch(`/api/v2/registration-sessions/${sessionId}/business-transforms`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ model_a: next.a, model_b: next.b }), signal });
      const body = await response.json(); if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
      businessTransforms.a = next.a; businessTransforms.b = next.b; refreshRoles(true);
      coordinateQuery?.invalidate(); resultState.visible = false;
      businessState.message = '已应用。视图已按各模型预变换更新，粗配准及旧 ICP 结果已失效，请重新配准。';
    } catch (error) { if (!signal.aborted) businessState.message = `应用失败：${String(error)}`; }
    finally { businessState.saving = false; }
  };
  panels.business = () => h(BusinessTransformPanel, {
    drafts: businessDraft, ...businessState,
    onChange: (model: ModelId, kind: keyof TransformParameters, index: number, value: string) => { businessDraft[model][kind][index] = value; },
    onReset: () => { setBusinessInputs('a', defaultTransform()); setBusinessInputs('b', defaultTransform()); },
    onApply: applyBusinessTransforms,
  });

  let clippingHandles: ClippingHandles | null = null;
  application.on('update', () => {
    if (resultSignature && resultSignature !== display.signature()) {
      resultState.visible = false;
      resultSignature = '';
    }
    const pose = display.getPose();
    const values = [...pose.position, ...pose.rotation];
    if (values.some((value, index) => value !== poseState.values[index])) poseState.values = values;
    viewState.initialMatrix = matrixText(display.getMovingLocalToFixedLocal());
    clippingScene?.sync();
    clippingScene?.drawHelpers();
    clippingHandles?.update();
  });

  const clippingPanel = root.querySelector<HTMLElement>('#clipping-panel')!;
  const clippingSettings = reactive<{ scope: 'both' | ModelId }>({ scope: 'both' });
  const toggleClippingPanel = () => {
    inspectorState.clipping = !inspectorState.clipping;
    if (inspectorState.clipping) {
      inspectorState.originPlanes = false;
      clippingPanel.parentElement!.scrollTop = 0;
    }
    refreshClippingMode();
  };

  const originalBounds = (() => {
    const min = new pc.Vec3(Math.min(cloudA.min.x, cloudB.min.x), Math.min(cloudA.min.y, cloudB.min.y), Math.min(cloudA.min.z, cloudB.min.z));
    const max = new pc.Vec3(Math.max(cloudA.max.x, cloudB.max.x), Math.max(cloudA.max.y, cloudB.max.y), Math.max(cloudA.max.z, cloudB.max.z));
    return { min, max };
  })();
  const axisInputs = reactive(createAxisRange(originalBounds.min, originalBounds.max));
  const independentAxisInputs = { a: reactive(createAxisRange(originalBounds.min, originalBounds.max)), b: reactive(createAxisRange(originalBounds.min, originalBounds.max)) };
  const resetAxisInputSet = (target: AxisRangeState, bounds: { min: pc.Vec3; max: pc.Vec3 }) => {
    Object.assign(target, createAxisRange(bounds.min, bounds.max));
  };
  const axisClipState = (target: AxisRangeState) => ({
    min: new pc.Vec3(target.x.min, target.y.min, target.z.min),
    max: new pc.Vec3(target.x.max, target.y.max, target.z.max),
    minEnabled: { x: target.x.minEnabled, y: target.y.minEnabled, z: target.z.minEnabled },
    maxEnabled: { x: target.x.maxEnabled, y: target.y.maxEnabled, z: target.z.maxEnabled },
  });
  const getAxisClipState = () => axisClipState(axisInputs);
  const setAxisBoundaryIn = setAxisRangeBoundary;
  const setAxisBoundary = (axis: ClipAxis, side: ClipSide, value: number) => setAxisBoundaryIn(axisInputs, axis, side, value);
  clippingScene = new ClippingSceneController({
    app: application,
    state: clippingState,
    jointBox: clipBox,
    independentBoxes: independentClipBoxes,
    pointMaterials,
    gaussian: gaussianController,
    scope: () => clippingSettings.scope,
    axisState: model => axisClipState(clippingState.controlMode === 'joint' ? axisInputs : independentAxisInputs[model]),
    originState: model => ({ sides: originPlanes.clipSides(model), worldToOrigin: originPlanes.getWorldToOrigin(model) }),
  });
  const clippingLabels = mountClippingLabels(viewportElement);
  resources.add(() => clippingLabels.destroy());
  clippingHandles = new ClippingHandles(
    application, camera, canvas, () => clippingState.controlMode === 'joint' ? clipBox : independentClipBoxes[clippingState.editor], originalBounds.min, originalBounds.max,
    () => queryActive && !clippingInteractionActive ? 'off' : clippingState.editedMode(),
    () => clippingState.controlMode === 'joint' ? getAxisClipState() : axisClipState(independentAxisInputs[clippingState.editor]),
    (axis, side, value) => clippingState.controlMode === 'joint' ? setAxisBoundary(axis, side, value) : setAxisBoundaryIn(independentAxisInputs[clippingState.editor], axis, side, value),
    () => clippingState.helperVisible(),
    active => { gizmoTransforming = active; },
    clippingLabels,
  );
  resources.add(() => clippingHandles?.destroy());

  const worldBounds = (models: ModelId[]) => {
    const min = new pc.Vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const max = new pc.Vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    models.forEach(model => {
      const cloud = clouds[model]; const transform = entities[model].getWorldTransform();
      for (const x of [cloud.min.x, cloud.max.x]) for (const y of [cloud.min.y, cloud.max.y]) for (const z of [cloud.min.z, cloud.max.z]) {
        const point = transform.transformPoint(new pc.Vec3(x, y, z)); min.min(point); max.max(point);
      }
    });
    return { min, max };
  };
  const fitClipBox = (models: ModelId[], box = clipBox) => {
    const target = worldBounds(models); const size = target.max.clone().sub(target.min);
    box.setPosition(target.min.clone().add(target.max).mulScalar(0.5));
    box.setEulerAngles(0, 0, 0);
    box.setLocalScale(Math.max(size.x, 0.001), Math.max(size.y, 0.001), Math.max(size.z, 0.001));
  };
  fitClipBox(['a', 'b']);
  fitClipBox(['a'], independentClipBoxes.a); fitClipBox(['b'], independentClipBoxes.b);
  const refreshClippingMode = () => {
    (['a', 'b'] as ModelId[]).forEach(model => {
      independentClipBoxes[model].enabled = clippingState.controlMode === 'independent'
        && clippingState.independentModes[model] === 'box' && clippingState.independentHelpers[model];
    });
    const clippingEnabled = clippingState.enabled();
    toolbarState.clippingActive = clippingEnabled;
    toolbarState.clippingTitle = `${clippingState.summary()}；点击打开或关闭剖切面板`;
    gaussianController.refreshStatus();
    const editedMode = clippingState.editedMode();
    clippingInteractionActive = inspectorState.clipping && editedMode !== 'off';
    clipBox.enabled = clippingState.controlMode === 'joint' && clippingState.jointMode === 'box' && clippingState.jointHelperVisible;
    attach();
    viewState.help = editedMode === 'box'
      ? '左键空白：旋转　中键：平移　滚轮：缩放　左键手柄：调整剖切长方体'
      : '左键空白：旋转　中键：平移　滚轮：缩放　左键平移轴／面：移动模型　左键旋转圆环：旋转模型';
  };
  const ranges = { joint: axisInputs, ...independentAxisInputs };
  type ClippingTarget = keyof typeof ranges;
  const resetRange = (target: ClippingTarget) => resetAxisInputSet(ranges[target], originalBounds);
  panels.clipping = () => h(ClippingPanel, {
    state: clippingState, scope: clippingSettings.scope, ranges,
    onClose: () => { inspectorState.clipping = false; clippingInteractionActive = false; attach(); },
    onControl: (mode: ClippingControlMode) => { clippingState.controlMode = mode; refreshClippingMode(); },
    onEditor: (model: ModelId) => { clippingState.editor = model; refreshClippingMode(); },
    onMode: (target: ClippingTarget, mode: ClippingMode) => {
      if (target === 'joint') clippingState.jointMode = mode; else clippingState.independentModes[target] = mode;
      refreshClippingMode();
    },
    onHelper: (target: ClippingTarget, visible: boolean) => {
      if (target === 'joint') clippingState.jointHelperVisible = visible; else clippingState.independentHelpers[target] = visible;
      refreshClippingMode();
    },
    onScope: (scope: 'both' | ModelId) => { clippingSettings.scope = scope; refreshClippingMode(); },
    onBoundary: (target: ClippingTarget, axis: ClipAxis, side: ClipSide, value: number) => setAxisBoundaryIn(ranges[target], axis, side, value),
    onEnabled: (target: ClippingTarget, axis: ClipAxis, side: ClipSide, value: boolean) => { ranges[target][axis][`${side}Enabled`] = value; },
    onReset: resetRange,
    onFit: (target: ClippingTarget, models: ModelId[]) => fitClipBox(models, target === 'joint' ? clipBox : independentClipBoxes[target]),
    onClear: (target: ClippingTarget) => {
      if (target === 'joint') clippingState.jointMode = 'off'; else clippingState.independentModes[target] = 'off';
      resetRange(target);
      fitClipBox(target === 'joint' ? ['a', 'b'] : [target], target === 'joint' ? clipBox : independentClipBoxes[target]);
      refreshClippingMode();
    },
  });

  refreshClippingMode();

  engine.bindInput({
    pointerMove: event => {
      if (clippingHandles?.pointerMove(event)) {
        canvas.style.cursor = clippingHandles.dragging ? 'grabbing' : 'grab';
        return true;
      }
      canvas.style.cursor = '';
      return false;
    },
    pointerLeave: () => clippingHandles?.pointerLeave(),
    pointerDown: event => {
      if (coordinateQuery?.pointerDown(event)) return true;
      return clippingHandles?.pointerDown(event) ?? false;
    },
    pointerUp: event => {
      clippingHandles?.pointerUp(event);
      clippingScene?.sync(true);
    },
    navigationBlocked: event => {
      if (coordinateQuery?.active && (coordinateQuery.hovered || coordinateQuery.dragging) && event.button === 0) return true;
      const gizmoHovered = clippingInteractionActive ? clipGizmoInput.hovered : movingGizmoInput.hovered;
      return event.button === 2 || gizmoTransforming || (event.button === 0 && gizmoHovered);
    },
    dragBlocked: () => gizmoTransforming || Boolean(coordinateQuery?.dragging),
  });

  const icpValues = reactive<Record<string, string>>({
    min_rms_decrease: '0.00001', sampling_limit: '50000', overlap: '1', random_seed: '42',
  });
  const icpState = shallowReactive({ disabled: false });
  panels.icp = () => h(IcpParameters, {
    values: icpValues, disabled: icpState.disabled,
    onChange: (key: string, value: string) => { icpValues[key] = value; },
  });
  const actionState = shallowReactive({ running: false, locked: false, cancelling: false, progress: false });
  const progressToolbar = root.querySelector<HTMLElement>('.viewport-toolbar')!;
  const positionProgress = () => {
    const top = progressToolbar.offsetTop + progressToolbar.offsetHeight + 8;
    resultState.progressTop = top;
  };
  const progressResize = new ResizeObserver(positionProgress);
  resources.add(() => progressResize.disconnect());
  progressResize.observe(progressToolbar);
  positionProgress();
  let latestProgressIteration = 0;
  const setRunning = (value: boolean) => {
    running = value;
    icpState.disabled = value || queryActive;
    poseState.disabled = value || queryActive;
    businessState.disabled = value || queryActive;
    roleState.disabled = value || queryActive;
    actionState.running = value;
    actionState.cancelling = false;
    toolbarState.locked = value || queryActive;
    actionState.locked = queryActive;
    attach();
  };
  const queryPanel = createCoordinatePanel(root, inspectorState, {
    onSource: model => coordinateQuery?.setSource(model),
    onChange: values => coordinateQuery?.setCoordinates(values),
    onInvalid: () => coordinateQuery?.handlePanelAction('invalid'),
    onAction: action => coordinateQuery?.handlePanelAction(action),
  });
  panels.query = queryPanel.render;
  const queryLabels = mountCoordinateLabels(root);
  resources.add(() => queryLabels.destroy());
  coordinateQuery = new CoordinateQuery({
    labels: queryLabels,
    panel: queryPanel,
    toolbar: queryToolbar,
    app: application, camera, canvas, entities, clouds, sessionId,
    origins: { a: infoA.origin as XYZ, b: infoB.origin as XYZ }, businessMatrices: display.businessMatrices, diagonal: scene.baseDiagonal,
    localToDisplay: model => display.localToDisplay(model),
    signature: () => display.signature(),
    setOriginal: original => { display.setOriginal(original); cameraController.fit(); },
    lock: active => {
      queryActive = active;
      icpState.disabled = active || running;
      poseState.disabled = active || running;
      businessState.disabled = active || running;
      roleState.disabled = active || running;
      toolbarState.locked = active || running;
      actionState.locked = active;
      inspectorState.clipping = false; clippingInteractionActive = false;
      if (active) inspectorState.originPlanes = false;
      attach();
    },
    visiblePoint: (model, point) => {
      if (!originPlanes.visiblePoint(model, point)) return false;
      return clippingScene?.visiblePoint(model, point) ?? true;
    },
  });
  resources.add(() => coordinateQuery?.destroy());
  const toggleOriginPlanes = () => {
    originPlaneUI.toggle();
    if (!inspectorState.originPlanes) return;
    inspectorState.clipping = false; clippingInteractionActive = false;
    if (coordinateQuery?.active) coordinateQuery.close();
    attach(); positionProgress();
  };
  const showResult = (result: RegistrationResult, jobId: string) => {
    display.setMovingLocalToFixedLocal(result.moving_local_to_fixed_local);
    coordinateQuery?.setResult(result, jobId);
    resultSignature = display.signature();
    resultState.direction = roleState.direction;
    resultState.result = result;
    resultState.visible = true;
  };
  const jobController = new RegistrationJobController({
    runningChanged: setRunning,
    statusChanged: status => { resultState.status = status; },
    progressChanged: (progress: RegistrationIteration) => {
      latestProgressIteration = progress.iteration;
      display.setMovingLocalToFixedLocal(progress.moving_local_to_fixed_local);
      resultState.progressText = `第 ${progress.iteration} 轮　RMS ${progress.rms.toFixed(6)} m　${progress.point_count.toLocaleString()} 点　${progress.elapsed_seconds.toFixed(2)} s`;
    },
    succeeded: (result, jobId) => {
      showResult(result, jobId);
      if (actionState.progress) {
        resultState.progressVisible = true;
        resultState.progressCompleted = true;
        resultState.progressText = `本次匹配已完成　RMS ${result.metrics.final_rms.toFixed(6)} m　${result.metrics.final_point_count.toLocaleString()} 点　${result.metrics.elapsed_seconds.toFixed(2)} s`;
        positionProgress();
      }
      resultState.status = '配准完成。';
    },
    cancelled: latestProgress => {
      if (latestProgress) display.setMovingLocalToFixedLocal(latestProgress.moving_local_to_fixed_local);
      resultState.status = latestProgress
        ? '任务已终止。视口停留在未收敛的中间姿态，该姿态不是有效业务矩阵，可继续粗调后重新执行。'
        : '任务已终止，可调整参数或粗配准后重新执行。';
    },
  }, signal);
  resources.add(() => jobController.destroy());
  const setProgress = (visible: boolean) => {
    actionState.progress = visible;
    jobController.setProgressVisible(actionState.progress);
    if (actionState.progress) {
      resultState.progressVisible = true;
      if (latestProgressIteration === 0) resultState.progressText = running ? '正在读取当前 ICP 进度……' : '已开启过程显示，等待执行 ICP。';
      positionProgress();
    } else resultState.progressVisible = false;
  };
  const cancelRegistration = async () => {
    if (!running || actionState.cancelling) return;
    actionState.cancelling = true;
    try {
      await jobController.cancel();
    } catch (error) {
      if (signal.aborted) return;
      resultState.status = `终止失败：${String(error)}`;
      actionState.cancelling = false;
    }
  };
  const runRegistration = async () => {
    if (running || queryActive) return;
    coordinateQuery?.invalidate();
    resultState.visible = false;
    latestProgressIteration = 0;
    resultState.progressCompleted = false;
    resultState.progressVisible = actionState.progress;
    resultState.progressText = actionState.progress ? '等待首轮 ICP 结果……' : '';
    jobController.setProgressVisible(actionState.progress);
    try {
      const request: RegistrationRequest = {
        initial_moving_local_to_fixed_local: display.getMovingLocalToFixedLocal(),
        output_direction: roleState.direction as RegistrationRequest['output_direction'],
        moving_model: roleState.moving as RegistrationRequest['moving_model'],
        min_rms_decrease: Number(icpValues.min_rms_decrease),
        sampling_limit: Number(icpValues.sampling_limit),
        overlap: Number(icpValues.overlap),
        random_seed: Number(icpValues.random_seed),
        show_registration_progress: true,
        coordinate_space: 'business',
      };
      await jobController.run(sessionId, request);
    } catch (error) { if (!signal.aborted) resultState.status = `失败：${String(error)}`; }
  };
  panels.actions = () => h(RegistrationActions, {
    ...actionState, onRun: runRegistration, onCancel: cancelRegistration, onProgress: setProgress,
  });

  const latest = session.registrations?.at(-1);
  if (latest?.status === 'succeeded' && latest.result_url) {
    const signature = display.signature();
    try {
      const response = await fetch(latest.result_url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as RegistrationResult;
      signal.throwIfAborted();
      const matching = result.coordinate_space === 'business' && (['a', 'b'] as ModelId[]).every(model => {
        const matrix = result.business_transforms?.[model].matrix ?? transformParametersMatrix(defaultTransform());
        return matrix.flat().every((value, index) => Math.abs(value-display.businessMatrices[model].flat()[index]) < 1e-12);
      });
      if (matching && signature === display.signature() && !running) {
        roleState.moving = result.moving_model;
        roleState.direction = latest.output_direction;
        refreshRoles(true);
        Object.keys(icpValues).forEach(name => {
          if (latest.parameters[name] !== undefined) icpValues[name] = String(latest.parameters[name]);
        });
        showResult(result, latest.job_id);
        resultState.status = '已恢复最近一次配准结果。';
        cameraController.fit();
      }
    } catch { if (!signal.aborted) resultState.status = '历史结果暂时无法加载，可重新配准。'; }
  }
}
