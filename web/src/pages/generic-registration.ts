import { waitForSession } from '../api/registration-api';
import { ResourceScope } from '../app/resource-scope';
import RegistrationRoles from '../views/workbench/RegistrationRoles.vue';
import ClippingPanel from '../views/workbench/ClippingPanel.vue';
import { createAxisRange, setAxisRangeBoundary, type AxisRangeState } from '../engine/modules/axis-range';
import { mountCoordinateLabels } from '../views/workbench/coordinate-labels';
import { mountCoordinatePanel } from '../views/workbench/coordinate-fields';
import { mountViewportToolbar } from '../views/workbench/viewport-toolbar';
import BusinessTransformPanel from '../views/workbench/BusinessTransformPanel.vue';
import CoarsePoseForm from '../views/workbench/CoarsePoseForm.vue';
import RegistrationActions from '../views/workbench/RegistrationActions.vue';
import IcpParameters from '../views/workbench/IcpParameters.vue';
import { createApp, h, reactive, shallowReactive } from 'vue';
import RegistrationResultPanel from '../views/workbench/RegistrationResultPanel.vue';
import * as pc from 'playcanvas';
import { CoordinateQuery } from '../engine/tools/CoordinateQuery';
import { transformParametersMatrix, transformXYZ, type TransformParameters, type XYZ } from '../coordinate-math';
import { RegistrationDisplay } from '../registration-display';
import { ClippingHandles, type ClipAxis, type ClipSide } from '../clipping-handles';
import { OriginPlaneController } from '../origin-planes';
import { mountOriginPlanePanel } from '../views/workbench/origin-plane-panel';
import { createPointCloudEntity, loadPreview, type PointCloudMaterial, type PreviewCloud } from '../point-cloud';
import '../workspace.css';
import '../view-gizmo.css';
import { ViewportCameraController } from '../engine/core/ViewportCameraController';
import { InputController } from '../engine/core/InputController';
import { RegistrationApplication } from '../engine/core/Application';
import { ToolManager } from '../engine/core/ToolManager';
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
import { mountWorkbenchLayout } from '../views/workbench/mount-workbench-layout';

const matrixText = (matrix: Matrix4) => matrix.map(row => row.map(value => value.toFixed(12)).join(' ')).join('\n');

function boundsOf(a: PreviewCloud, b: PreviewCloud): { center: pc.Vec3; diagonal: number } {
  const min = new pc.Vec3(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z));
  const max = new pc.Vec3(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z));
  return { center: min.clone().add(max).mulScalar(0.5), diagonal: max.clone().sub(min).length() };
}

function cloudDiagonal(cloud: PreviewCloud): number {
  return cloud.max.clone().sub(cloud.min).length();
}

export async function renderGenericRegistration(
  root: HTMLElement,
  sessionId: string,
  externalSignal?: AbortSignal,
  navigateHome?: () => void,
): Promise<() => void> {
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
    await initializeWorkbench(root, sessionId, signal, resources, navigateHome);
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
  navigateHome?: () => void,
): Promise<void> {
  root.innerHTML = '<main class="loading"><h2>正在生成双模型预览</h2><pre id="loading-status">queued</pre></main>';
  const statusElement = root.querySelector('#loading-status')!;
  const session = await waitForSession(sessionId, signal, status => {
    statusElement.textContent = `预览状态：${status}`;
  });
  const [cloudA, cloudB] = await Promise.all([
    loadPreview(session.model_a_preview_url!, signal), loadPreview(session.model_b_preview_url!, signal),
  ]);
  signal.throwIfAborted();
  const infoA = session.metadata!.models.a;
  const infoB = session.metadata!.models.b;
  const defaultTransform = (): TransformParameters => ({ translation: [0,0,0], rotation_degrees: [0,0,0], scale: [1,1,1] });
  const businessTransforms: Record<ModelId, TransformParameters> = session.business_transforms ?? { a: defaultTransform(), b: defaultTransform() };
  resources.add(mountWorkbenchLayout(root, session));

  const roleState = reactive({ moving: session.moving_model, direction: session.output_direction, disabled: false });
  const effectiveMoving = (): ModelId => roleState.moving === 'auto'
    ? session.metadata!.recommended_moving_model : roleState.moving;


  const canvas = root.querySelector<HTMLCanvasElement>('#viewport')!;
  const viewportElement = canvas.parentElement!;
  viewportElement.style.minHeight = '0';
  viewportElement.style.overflow = 'hidden';
  const engine = new RegistrationApplication({ canvas, viewport: viewportElement });
  resources.add(() => engine.destroy());
  const application = engine.app;
  const camera = engine.camera;
  const entityA = createPointCloudEntity(application, cloudA, new pc.Color(0.68, 0.72, 0.78), 'Model A');
  const entityB = createPointCloudEntity(application, cloudB, new pc.Color(0.68, 0.72, 0.78), 'Model B');
  application.root.addChild(entityA); application.root.addChild(entityB);
  const entities = { a: entityA, b: entityB };
  const clouds = { a: cloudA, b: cloudB };
  const pointMaterials: Record<ModelId, PointCloudMaterial> = {
    a: entityA.render!.meshInstances[0].material as PointCloudMaterial,
    b: entityB.render!.meshInstances[0].material as PointCloudMaterial,
  };
  const createClipBox = (name: string, color: pc.Color) => {
    const box = new pc.Entity(name); box.addComponent('render', { type: 'box' });
    const material = new pc.StandardMaterial();
    material.diffuse = color; material.emissive = color.clone().mulScalar(0.25);
    material.opacity = 0.055; material.blendType = pc.BLEND_NORMAL; material.depthWrite = false; material.update();
    box.render!.meshInstances.forEach(instance => { instance.material = material; });
    application.root.addChild(box); box.enabled = false; return box;
  };
  const clipBox = createClipBox('Joint Clipping Box', new pc.Color(0.12, 0.82, 0.68));
  const independentClipBoxes: Record<ModelId, pc.Entity> = {
    a: createClipBox('Model A Clipping Box', new pc.Color(0.45, 0.65, 0.9)),
    b: createClipBox('Model B Clipping Box', new pc.Color(1.0, 0.72, 0.08)),
  };
  const modelVisible: Record<ModelId, boolean> = { a: true, b: true };
  const display = new RegistrationDisplay(application.root, entities,
    { a: infoA.origin as XYZ, b: infoB.origin as XYZ }, businessTransforms);
  display.reset(effectiveMoving());
  const bounds = boundsOf(cloudA, cloudB);
  const modelDiagonals: Record<ModelId, number> = { a: cloudDiagonal(cloudA), b: cloudDiagonal(cloudB) };
  const originPlaneUI = mountOriginPlanePanel(root);
  resources.add(() => originPlaneUI.destroy());
  const originPlanes = new OriginPlaneController(application, entities,
    { a: infoA.origin as XYZ, b: infoB.origin as XYZ }, modelDiagonals, modelVisible, originPlaneUI.state);
  resources.add(() => originPlanes.destroy());
  const displayBounds = () => {
    const min = new pc.Vec3(Infinity, Infinity, Infinity);
    const max = new pc.Vec3(-Infinity, -Infinity, -Infinity);
    (['a', 'b'] as ModelId[]).forEach(model => {
      const cloud = clouds[model]; const matrix = display.localToDisplay(model);
      for (const x of [cloud.min.x, cloud.max.x]) for (const y of [cloud.min.y, cloud.max.y]) for (const z of [cloud.min.z, cloud.max.z]) {
        const point = new pc.Vec3(...transformXYZ(matrix, [x, y, z]));
        min.min(point); max.max(point);
      }
    });
    return { min, max };
  };
  const cameraController = new ViewportCameraController({
    camera,
    canvas,
    root,
    baseDiagonal: bounds.diagonal,
    getBounds: displayBounds,
  });
  resources.add(() => cameraController.destroy());

  const movingTranslateLayer = pc.TranslateGizmo.createLayer(application, 'Moving Model Translation');
  const movingRotateLayer = pc.RotateGizmo.createLayer(application, 'Moving Model Rotation');
  const clipTranslateLayer = pc.TranslateGizmo.createLayer(application, 'Clipping Box Translation');
  const clipRotateLayer = pc.RotateGizmo.createLayer(application, 'Clipping Box Rotation');
  const translate = new pc.TranslateGizmo(camera.camera!, movingTranslateLayer);
  resources.add(() => translate.destroy());
  const rotate = new pc.RotateGizmo(camera.camera!, movingRotateLayer);
  resources.add(() => rotate.destroy());
  const clipTranslate = new pc.TranslateGizmo(camera.camera!, clipTranslateLayer);
  resources.add(() => clipTranslate.destroy());
  const clipRotate = new pc.RotateGizmo(camera.camera!, clipRotateLayer);
  resources.add(() => clipRotate.destroy());
  [translate, clipTranslate].forEach(gizmo => {
    gizmo.axisGap = 0.08; gizmo.axisLineLength = 0.72; gizmo.axisPlaneSize = 0.14; gizmo.axisPlaneGap = 0.22;
  });
  [rotate, clipRotate].forEach(gizmo => { gizmo.centerRadius = 0.001; gizmo.ringTolerance = 0.025; });
  translate.mouseButtons[1] = translate.mouseButtons[2] = false;
  rotate.mouseButtons[1] = rotate.mouseButtons[2] = false;
  clipTranslate.mouseButtons[1] = clipTranslate.mouseButtons[2] = false;
  clipRotate.mouseButtons[1] = clipRotate.mouseButtons[2] = false;
  const clippingState = reactive(new ClippingStateController());
  let clippingScene: ClippingSceneController | null = null;
  let clippingInteractionActive = false;
  let running = false;
  let queryActive = false;
  let coordinateQuery: CoordinateQuery | null = null;
  let resultSignature = '';
  let gizmoTransforming = false;
  let translateGizmoHovered = false; let rotateGizmoHovered = false;
  let translateGizmoTransforming = false; let rotateGizmoTransforming = false;
  const onTransformStart = () => { gizmoTransforming = true; };
  const onTransformEnd = () => { gizmoTransforming = false; };
  const refreshMovingGizmoInput = () => {
    translate.mouseButtons[0] = translateGizmoTransforming || !rotateGizmoTransforming;
    rotate.mouseButtons[0] = rotateGizmoTransforming
      || (!translateGizmoTransforming && !translateGizmoHovered && rotateGizmoHovered);
  };
  translate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => {
    translateGizmoHovered = Boolean(meshInstance); refreshMovingGizmoInput();
  });
  rotate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => {
    rotateGizmoHovered = Boolean(meshInstance); refreshMovingGizmoInput();
  });
  translate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => {
    translateGizmoTransforming = true; refreshMovingGizmoInput(); onTransformStart();
  });
  translate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
    translateGizmoTransforming = false; refreshMovingGizmoInput(); onTransformEnd();
  });
  rotate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => {
    rotateGizmoTransforming = true; refreshMovingGizmoInput(); onTransformStart();
  });
  rotate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
    rotateGizmoTransforming = false; refreshMovingGizmoInput(); onTransformEnd();
  });
  let clipTranslateHovered = false; let clipRotateHovered = false;
  let clipTranslateTransforming = false; let clipRotateTransforming = false;
  const refreshClipGizmoInput = () => {
    clipTranslate.mouseButtons[0] = clipTranslateTransforming || !clipRotateTransforming;
    clipRotate.mouseButtons[0] = clipRotateTransforming
      || (!clipTranslateTransforming && !clipTranslateHovered && clipRotateHovered);
  };
  clipTranslate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => {
    clipTranslateHovered = Boolean(meshInstance); refreshClipGizmoInput();
  });
  clipRotate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => {
    clipRotateHovered = Boolean(meshInstance); refreshClipGizmoInput();
  });
  clipTranslate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => {
    clipTranslateTransforming = true; refreshClipGizmoInput(); onTransformStart();
  });
  clipTranslate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
    clipTranslateTransforming = false; refreshClipGizmoInput(); onTransformEnd();
  });
  clipRotate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => {
    clipRotateTransforming = true; refreshClipGizmoInput(); onTransformStart();
  });
  clipRotate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
    clipRotateTransforming = false; refreshClipGizmoInput(); onTransformEnd();
  });
  refreshMovingGizmoInput(); refreshClipGizmoInput();
  const movingEntity = () => entities[effectiveMoving()];
  [translate, rotate].forEach(gizmo => gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => display.applyHandle()));
  type EditingToolId = 'idle' | 'model-transform' | 'clipping' | 'coordinate-query';
  const toolManager = new ToolManager<EditingToolId>();
  resources.add(() => toolManager.destroy());
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

  const visibilityButtons: Record<ModelId, HTMLButtonElement> = {
    a: root.querySelector<HTMLButtonElement>('#toggle-model-a')!,
    b: root.querySelector<HTMLButtonElement>('#toggle-model-b')!,
  };
  const setModelVisible = (model: ModelId, visible: boolean) => {
    modelVisible[model] = visible;
    entities[model].enabled = visible;
    visibilityButtons[model].classList.toggle('active', visible);
    visibilityButtons[model].textContent = `${model.toUpperCase()}：${visible ? '显示' : '隐藏'}`;
    visibilityButtons[model].setAttribute('aria-pressed', String(visible));
    attach();
  };
  (['a', 'b'] as ModelId[]).forEach(model => {
    visibilityButtons[model].addEventListener('click', () => setModelVisible(model, !modelVisible[model]));
    visibilityButtons[model].setAttribute('aria-pressed', 'true');
  });

  const gaussianController = new GaussianDisplayController({
    app: application,
    root,
    entities,
    urls: { a: session.gaussian_a_url, b: session.gaussian_b_url },
    bytes: { a: session.inputs?.model_a_bytes, b: session.inputs?.model_b_bytes },
    origins: { a: infoA.origin as XYZ, b: infoB.origin as XYZ },
    clippingEnabled: () => clippingState.enabled(),
    clipStateChanged: () => clippingScene?.sync(true),
    presentationChanged: attach,
  });
  resources.add(() => gaussianController.destroy());

  const poseState = shallowReactive({ values: [0, 0, 0, 0, 0, 0], disabled: false });
  const poseApp = createApp({ render: () => h(CoarsePoseForm, {
    ...poseState,
    onChange: (values: number[]) => {
      display.setPose(values.slice(0, 3) as XYZ, values.slice(3) as XYZ);
    },
  }) });
  poseApp.mount(root.querySelector<HTMLElement>('#coarse-pose-form')!);
  resources.add(() => poseApp.unmount());

  const refreshRoles = (reset = false) => {
    const moving = effectiveMoving(); const fixed = moving === 'a' ? 'b' : 'a';
    if (reset) display.reset(moving);
    const recolor = (entity: pc.Entity, color: pc.Color) => entity.render!.meshInstances.forEach(instance => {
      (instance.material as PointCloudMaterial).setPointColor(color);
    });
    recolor(entities[moving], new pc.Color(1.0, 0.72, 0.08));
    recolor(entities[fixed], new pc.Color(0.68, 0.72, 0.78));
    root.querySelector<HTMLElement>('#badge')!.textContent = `移动 ${moving.toUpperCase()}（黄色）　固定 ${fixed.toUpperCase()}（灰色）`;
    attach();
  };
  const rolesApp = createApp({ render: () => h(RegistrationRoles, {
    ...roleState, recommended: session.metadata!.recommended_moving_model, diagonals: modelDiagonals,
    onMoving: (value: RegistrationRequest['moving_model']) => { roleState.moving = value; coordinateQuery?.invalidate(); refreshRoles(true); },
    onDirection: (value: RegistrationRequest['output_direction']) => { roleState.direction = value; root.querySelector<HTMLElement>('#result')!.hidden = true; },
  }) });
  rolesApp.mount(root.querySelector<HTMLElement>('#registration-roles')!);
  resources.add(() => rolesApp.unmount());
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
      coordinateQuery?.invalidate(); root.querySelector<HTMLElement>('#result')!.hidden = true;
      businessState.message = '已应用。视图已按各模型预变换更新，粗配准及旧 ICP 结果已失效，请重新配准。';
    } catch (error) { if (!signal.aborted) businessState.message = `应用失败：${String(error)}`; }
    finally { businessState.saving = false; }
  };
  const businessPanelApp = createApp({ render: () => h(BusinessTransformPanel, {
    drafts: businessDraft, ...businessState,
    onChange: (model: ModelId, kind: keyof TransformParameters, index: number, value: string) => { businessDraft[model][kind][index] = value; },
    onReset: () => { setBusinessInputs('a', defaultTransform()); setBusinessInputs('b', defaultTransform()); },
    onApply: applyBusinessTransforms,
  }) });
  businessPanelApp.mount(root.querySelector<HTMLElement>('#business-transform-panel')!);
  resources.add(() => businessPanelApp.unmount());

  let clippingHandles: ClippingHandles | null = null;
  application.on('update', () => {
    if (resultSignature && resultSignature !== display.signature()) {
      root.querySelector<HTMLElement>('#result')!.hidden = true;
      resultSignature = '';
    }
    const pose = display.getPose();
    const values = [...pose.position, ...pose.rotation];
    if (values.some((value, index) => value !== poseState.values[index])) poseState.values = values;
    root.querySelector<HTMLElement>('#initial-matrix')!.textContent = matrixText(display.getMovingLocalToFixedLocal());
    clippingScene?.sync();
    clippingScene?.drawHelpers();
    clippingHandles?.update();
  });

  const resetButton = root.querySelector<HTMLButtonElement>('#reset')!;
  const clippingToggle = root.querySelector<HTMLButtonElement>('#clipping-toggle')!;
  const clippingPanel = root.querySelector<HTMLElement>('#clipping-panel')!;
  const originPlanePanel = root.querySelector<HTMLElement>('.origin-planes-panel')!;
  const clippingSettings = reactive<{ scope: 'both' | ModelId }>({ scope: 'both' });
  resetButton.addEventListener('click', () => { if (!running) display.reset(effectiveMoving()); });
  root.querySelector('#fit')!.addEventListener('click', () => cameraController.fit());
  clippingToggle.addEventListener('click', () => {
    clippingPanel.hidden = !clippingPanel.hidden;
    if (!clippingPanel.hidden) {
      originPlanePanel.hidden = true;
      clippingPanel.parentElement!.scrollTop = 0;
    }
    refreshClippingMode();
  });

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
  clippingHandles = new ClippingHandles(
    application, camera, canvas, () => clippingState.controlMode === 'joint' ? clipBox : independentClipBoxes[clippingState.editor], originalBounds.min, originalBounds.max,
    () => queryActive && !clippingInteractionActive ? 'off' : clippingState.editedMode(),
    () => clippingState.controlMode === 'joint' ? getAxisClipState() : axisClipState(independentAxisInputs[clippingState.editor]),
    (axis, side, value) => clippingState.controlMode === 'joint' ? setAxisBoundary(axis, side, value) : setAxisBoundaryIn(independentAxisInputs[clippingState.editor], axis, side, value),
    () => clippingState.helperVisible(),
    active => { gizmoTransforming = active; },
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
    clippingToggle.classList.toggle('active', clippingEnabled);
    clippingToggle.setAttribute('aria-pressed', String(clippingEnabled));
    clippingToggle.title = `${clippingState.summary()}；点击打开或关闭剖切面板`;
    gaussianController.refreshStatus();
    const editedMode = clippingState.editedMode();
    clippingInteractionActive = !clippingPanel.hidden && editedMode !== 'off';
    clipBox.enabled = clippingState.controlMode === 'joint' && clippingState.jointMode === 'box' && clippingState.jointHelperVisible;
    attach();
    root.querySelector<HTMLElement>('#viewport-help')!.textContent = editedMode === 'box'
      ? '左键空白：旋转　中键：平移　滚轮：缩放　左键手柄：调整剖切长方体'
      : '左键空白：旋转　中键：平移　滚轮：缩放　左键平移轴／面：移动模型　左键旋转圆环：旋转模型';
  };
  const ranges = { joint: axisInputs, ...independentAxisInputs };
  type ClippingTarget = keyof typeof ranges;
  const resetRange = (target: ClippingTarget) => resetAxisInputSet(ranges[target], originalBounds);
  const clippingPanelApp = createApp({ render: () => h(ClippingPanel, {
    state: clippingState, scope: clippingSettings.scope, ranges,
    onClose: () => { clippingPanel.hidden = true; clippingInteractionActive = false; attach(); },
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
  }) });
  clippingPanelApp.mount(clippingPanel);
  resources.add(() => clippingPanelApp.unmount());

  refreshClippingMode();
  root.querySelector('#new-task')!.addEventListener('click', () => {
    if (navigateHome) navigateHome();
    else location.href = '/';
  });

  const inputController = new InputController(canvas, cameraController, {
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
      const clipGizmoHovered = clipTranslateHovered || clipRotateHovered;
      const gizmoHovered = clippingInteractionActive ? clipGizmoHovered : (translateGizmoHovered || rotateGizmoHovered);
      return event.button === 2 || gizmoTransforming || (event.button === 0 && gizmoHovered);
    },
    dragBlocked: () => gizmoTransforming || Boolean(coordinateQuery?.dragging),
  });
  resources.add(() => inputController.destroy());

  const resultState = shallowReactive<{ result: RegistrationResult | null; direction: string }>({
    result: null, direction: 'a_to_b',
  });
  const resultApp = createApp({ render: () => h(RegistrationResultPanel, resultState) });
  resultApp.mount(root.querySelector<HTMLElement>('#result')!);
  resources.add(() => resultApp.unmount());
  const icpValues = reactive<Record<string, string>>({
    min_rms_decrease: '0.00001', sampling_limit: '50000', overlap: '1', random_seed: '42',
  });
  const icpState = shallowReactive({ disabled: false });
  const icpApp = createApp({ render: () => h(IcpParameters, {
    values: icpValues, disabled: icpState.disabled,
    onChange: (key: string, value: string) => { icpValues[key] = value; },
  }) });
  icpApp.mount(root.querySelector<HTMLElement>('#icp-parameters')!);
  resources.add(() => icpApp.unmount());
  const actionState = shallowReactive({ running: false, locked: false, cancelling: false, progress: false });
  const iterationProgress = root.querySelector<HTMLElement>('#iteration-progress')!;
  const progressToolbar = root.querySelector<HTMLElement>('.viewport-toolbar')!;
  const positionProgress = () => {
    const top = progressToolbar.offsetTop + progressToolbar.offsetHeight + 8;
    iterationProgress.style.top = `${top}px`;
  };
  const progressResize = new ResizeObserver(positionProgress);
  resources.add(() => progressResize.disconnect());
  progressResize.observe(progressToolbar);
  progressResize.observe(iterationProgress);
  positionProgress();
  const registrationControls = [resetButton];
  let latestProgressIteration = 0;
  const setRunning = (value: boolean) => {
    running = value;
    icpState.disabled = value || queryActive;
    poseState.disabled = value || queryActive;
    businessState.disabled = value || queryActive;
    roleState.disabled = value || queryActive;
    actionState.running = value;
    actionState.cancelling = false;
    registrationControls.forEach(control => { control.disabled = value || queryActive; });
    actionState.locked = queryActive;
    attach();
  };
  const queryToolbar = mountViewportToolbar(root, {
    query: () => coordinateQuery?.toggleQuery(),
    toggleOrigin: model => coordinateQuery?.toggleOrigin(model) ?? false,
  });
  resources.add(() => queryToolbar.destroy());
  const queryPanel = mountCoordinatePanel(root, {
    onSource: model => coordinateQuery?.setSource(model),
    onChange: values => coordinateQuery?.setCoordinates(values),
    onInvalid: () => coordinateQuery?.handlePanelAction('invalid'),
    onAction: action => coordinateQuery?.handlePanelAction(action),
  });
  resources.add(() => queryPanel.destroy());
  const queryLabels = mountCoordinateLabels(root);
  resources.add(() => queryLabels.destroy());
  coordinateQuery = new CoordinateQuery({
    labels: queryLabels,
    panel: queryPanel,
    toolbar: queryToolbar,
    app: application, camera, canvas, entities, clouds, sessionId,
    origins: { a: infoA.origin as XYZ, b: infoB.origin as XYZ }, businessMatrices: display.businessMatrices, diagonal: bounds.diagonal,
    localToDisplay: model => display.localToDisplay(model),
    signature: () => display.signature(),
    setOriginal: original => { display.setOriginal(original); cameraController.fit(); },
    lock: active => {
      queryActive = active;
      icpState.disabled = active || running;
      poseState.disabled = active || running;
      businessState.disabled = active || running;
      roleState.disabled = active || running;
      registrationControls.forEach(control => { control.disabled = active || running; });
      actionState.locked = active;
      clippingPanel.hidden = true; clippingInteractionActive = false;
      if (active) originPlanePanel.hidden = true;
      clippingToggle.disabled = false;
      attach();
    },
    visiblePoint: (model, point) => {
      if (!originPlanes.visiblePoint(model, point)) return false;
      return clippingScene?.visiblePoint(model, point) ?? true;
    },
  });
  resources.add(() => coordinateQuery?.destroy());
  root.querySelector('#origin-planes-toggle')!.addEventListener('click', () => {
    if (originPlanePanel.hidden) return;
    clippingPanel.hidden = true; clippingInteractionActive = false;
    if (coordinateQuery?.active) coordinateQuery.close();
    attach(); positionProgress();
  });
  const showResult = (result: RegistrationResult, jobId: string) => {
    display.setMovingLocalToFixedLocal(result.moving_local_to_fixed_local);
    coordinateQuery?.setResult(result, jobId);
    resultSignature = display.signature();
    resultState.direction = roleState.direction;
    resultState.result = result;
    root.querySelector<HTMLElement>('#result')!.hidden = false;
  };
  const log = root.querySelector<HTMLElement>('#job-status')!;
  const jobController = new RegistrationJobController({
    runningChanged: setRunning,
    statusChanged: status => { log.textContent = status; },
    progressChanged: (progress: RegistrationIteration) => {
      latestProgressIteration = progress.iteration;
      display.setMovingLocalToFixedLocal(progress.moving_local_to_fixed_local);
      iterationProgress.textContent = `第 ${progress.iteration} 轮　RMS ${progress.rms.toFixed(6)} m　${progress.point_count.toLocaleString()} 点　${progress.elapsed_seconds.toFixed(2)} s`;
    },
    succeeded: (result, jobId) => {
      showResult(result, jobId);
      if (actionState.progress) {
        iterationProgress.hidden = false;
        iterationProgress.classList.add('completed');
        iterationProgress.textContent = `本次匹配已完成　RMS ${result.metrics.final_rms.toFixed(6)} m　${result.metrics.final_point_count.toLocaleString()} 点　${result.metrics.elapsed_seconds.toFixed(2)} s`;
        positionProgress();
      }
      log.textContent = '配准完成。';
    },
    cancelled: latestProgress => {
      if (latestProgress) display.setMovingLocalToFixedLocal(latestProgress.moving_local_to_fixed_local);
      log.textContent = latestProgress
        ? '任务已终止。视口停留在未收敛的中间姿态，该姿态不是有效业务矩阵，可继续粗调后重新执行。'
        : '任务已终止，可调整参数或粗配准后重新执行。';
    },
  }, signal);
  resources.add(() => jobController.destroy());
  const setProgress = (visible: boolean) => {
    actionState.progress = visible;
    jobController.setProgressVisible(actionState.progress);
    if (actionState.progress) {
      iterationProgress.hidden = false;
      if (latestProgressIteration === 0) iterationProgress.textContent = running ? '正在读取当前 ICP 进度……' : '已开启过程显示，等待执行 ICP。';
      positionProgress();
    } else iterationProgress.hidden = true;
  };
  const cancelRegistration = async () => {
    if (!running || actionState.cancelling) return;
    actionState.cancelling = true;
    try {
      await jobController.cancel();
    } catch (error) {
      if (signal.aborted) return;
      log.textContent = `终止失败：${String(error)}`;
      actionState.cancelling = false;
    }
  };
  const runRegistration = async () => {
    if (running || queryActive) return;
    coordinateQuery?.invalidate();
    latestProgressIteration = 0;
    iterationProgress.classList.remove('completed');
    iterationProgress.hidden = !actionState.progress;
    iterationProgress.textContent = actionState.progress ? '等待首轮 ICP 结果……' : '';
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
    } catch (error) { if (!signal.aborted) log.textContent = `失败：${String(error)}`; }
  };
  const actionsApp = createApp({ render: () => h(RegistrationActions, {
    ...actionState, onRun: runRegistration, onCancel: cancelRegistration, onProgress: setProgress,
  }) });
  actionsApp.mount(root.querySelector<HTMLElement>('#registration-actions-host')!);
  resources.add(() => actionsApp.unmount());

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
        root.querySelector<HTMLElement>('#job-status')!.textContent = '已恢复最近一次配准结果。';
        cameraController.fit();
      }
    } catch { if (!signal.aborted) root.querySelector<HTMLElement>('#job-status')!.textContent = '历史结果暂时无法加载，可重新配准。'; }
  }
}
