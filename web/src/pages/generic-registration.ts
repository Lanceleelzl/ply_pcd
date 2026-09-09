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
import { createPointCloudEntity, loadPreview, type PointCloudMaterial, type PreviewCloud } from '../point-cloud';
import '../workspace.css';
import '../view-gizmo.css';
import { ViewportCameraController } from '../engine/core/ViewportCameraController';
import { InputController } from '../engine/core/InputController';
import { RegistrationApplication } from '../engine/core/Application';
import { ToolManager } from '../engine/core/ToolManager';
import { RegistrationJobController } from '../engine/modules/RegistrationJobController';
import { GaussianDisplayController } from '../engine/modules/GaussianDisplayController';
import { ClippingStateController } from '../engine/modules/ClippingStateController';
import { ClippingSceneController } from '../engine/modules/ClippingSceneController';
import type {
  Matrix4,
  ModelId,
  RegistrationIteration,
  RegistrationRequest,
  RegistrationResult,
  RegistrationSession,
} from '../api/contracts';
import { mountWorkbenchLayout } from '../views/workbench/mount-workbench-layout';

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const matrixText = (matrix: Matrix4) => matrix.map(row => row.map(value => value.toFixed(12)).join(' ')).join('\n');
const formatBytes = (bytes?: number) => bytes
  ? `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
  : '大小未知';
const transformEditor = (model: ModelId, value: TransformParameters): string => {
  const row = (label: string, kind: keyof TransformParameters, values: XYZ) => `<div class="transform-row"><span>${label}</span>${['X','Y','Z'].map((axis,index) => `<label class="axis-input"><input aria-label="模型 ${model.toUpperCase()} ${label} ${axis}" type="number" step="any" data-business-model="${model}" data-business-kind="${kind}" data-index="${index}" value="${values[index]}"><span>${axis}</span></label>`).join('')}</div>`;
  return `<div class="business-transform-model"><h3>模型 ${model.toUpperCase()}</h3>${row('平移／m','translation',value.translation)}${row('旋转／°','rotation_degrees',value.rotation_degrees)}${row('缩放','scale',value.scale)}<pre class="matrix" data-business-matrix="${model}">${matrixText(transformParametersMatrix(value))}</pre></div>`;
};

function boundsOf(a: PreviewCloud, b: PreviewCloud): { center: pc.Vec3; diagonal: number } {
  const min = new pc.Vec3(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z));
  const max = new pc.Vec3(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z));
  return { center: min.clone().add(max).mulScalar(0.5), diagonal: max.clone().sub(min).length() };
}

function cloudDiagonal(cloud: PreviewCloud): number {
  return cloud.max.clone().sub(cloud.min).length();
}

async function waitForSession(sessionId: string, statusElement: HTMLElement, signal: AbortSignal): Promise<RegistrationSession> {
  while (true) {
    const response = await fetch(`/api/v2/registration-sessions/${sessionId}`, { signal });
    const status = await response.json() as RegistrationSession;
    statusElement.textContent = `预览状态：${status.status}`;
    if (status.status === 'ready') return status;
    if (status.status === 'failed') throw new Error(status.error ?? '预览生成失败');
    await sleep(1000);
  }
}

export async function renderGenericRegistration(
  root: HTMLElement,
  sessionId: string,
  externalSignal?: AbortSignal,
  navigateHome?: () => void,
): Promise<() => void> {
  const lifecycle = new AbortController();
  const abortLifecycle = () => lifecycle.abort();
  externalSignal?.addEventListener('abort', abortLifecycle, { once: true });
  const { signal } = lifecycle;
  root.innerHTML = '<main class="loading"><h2>正在生成双模型预览</h2><pre id="loading-status">queued</pre></main>';
  const session = await waitForSession(sessionId, root.querySelector('#loading-status')!, signal);
  const [cloudA, cloudB] = await Promise.all([
    loadPreview(session.model_a_preview_url!, signal), loadPreview(session.model_b_preview_url!, signal),
  ]);
  const infoA = session.metadata!.models.a;
  const infoB = session.metadata!.models.b;
  const defaultTransform = (): TransformParameters => ({ translation: [0,0,0], rotation_degrees: [0,0,0], scale: [1,1,1] });
  const businessTransforms: Record<ModelId, TransformParameters> = session.business_transforms ?? { a: defaultTransform(), b: defaultTransform() };
  root.innerHTML = `
    <main class="editor integrated-editor"><div class="workspace integrated-workspace">
      <aside class="panel workflow-panel">
        <div class="workflow-title"><div><h1>通用点云双向配准</h1><small>A：${infoA.format.toUpperCase()}　B：${infoB.format.toUpperCase()}</small></div><button id="new-task">新建</button></div>
        <section class="workflow-step completed"><h2><span>1</span> 模型</h2><p>A：${infoA.source_point_count.toLocaleString()} 点<br>B：${infoB.source_point_count.toLocaleString()} 点</p><p id="badge" class="model-role-summary"></p><details class="business-transform-editor"><summary>业务场景矩阵</summary><p class="business-transform-note">文件坐标 → 业务坐标；应用后需重新配准。</p>${transformEditor('a',businessTransforms.a)}${transformEditor('b',businessTransforms.b)}<div class="business-transform-actions"><button id="save-business-transforms">应用场景矩阵</button><button id="reset-business-transforms">恢复默认</button></div><p id="business-transform-status" class="business-transform-note"></p></details><p id="gaussian-status" class="gaussian-status" hidden></p></section>
        <section class="workflow-step"><h2><span>2</span> 方向与粗配准</h2>
          <div class="role-grid">
            <label class="parameter-label">转换方向<select id="output-direction"><option value="a_to_b">模型 A → 模型 B</option><option value="b_to_a">模型 B → 模型 A</option></select></label>
            <label class="parameter-label">ICP 移动模型<select id="moving-model"><option value="auto">自动推荐（${session.metadata!.recommended_moving_model.toUpperCase()}）</option><option value="a">移动模型 A</option><option value="b">移动模型 B</option></select></label>
          </div>
          <p id="role-hint" class="step-hint"></p><p id="range-risk" class="range-risk" hidden></p>
          <div class="pose-row"><span>平移／m</span><div class="field-grid" id="position"></div></div>
          <div class="pose-row"><span>旋转／°</span><div class="field-grid" id="rotation"></div></div>
          <details><summary>初始 moving-local→fixed-local</summary><pre id="initial-matrix" class="matrix"></pre></details>
        </section>
        <section class="workflow-step"><h2><span>3</span> ICP 参数</h2><div id="icp-parameters"></div><div id="registration-actions-host"></div></section>
        <section class="workflow-step"><h2><span>4</span> 结果</h2><pre id="job-status" class="status timeline">尚未提交</pre>
          <section id="result" class="result" hidden></section>
        </section>
      </aside>
      <section class="viewport"><canvas id="viewport"></canvas><div class="viewport-toolbar toolbar"><strong>粗配准</strong><button id="reset" title="清除当前移动模型的平移和旋转，恢复到模型刚加载时的位置">重置</button><button id="fit">适应全部</button><button id="clipping-toggle">剖切</button><div class="model-visibility" aria-label="模型显示控制"><button id="toggle-model-a" class="active">A：显示</button><button id="toggle-model-b" class="active">B：显示</button><button id="gaussian-model-a" class="gaussian-toggle${session.gaussian_a_url ? ' available' : ''}" ${session.gaussian_a_url ? '' : 'disabled'} title="${session.gaussian_a_url ? `加载模型 A 原始 Gaussian（${formatBytes(session.inputs?.model_a_bytes)}）` : '模型 A 不包含完整 Gaussian 属性'}">A：高斯</button><button id="gaussian-model-b" class="gaussian-toggle${session.gaussian_b_url ? ' available' : ''}" ${session.gaussian_b_url ? '' : 'disabled'} title="${session.gaussian_b_url ? `加载模型 B 原始 Gaussian（${formatBytes(session.inputs?.model_b_bytes)}）` : '模型 B 不包含完整 Gaussian 属性'}">B：高斯</button><button id="origin-planes-toggle" aria-pressed="false">原点平面</button></div></div><div id="iteration-progress" class="viewport-progress" role="status" aria-live="polite" hidden></div>
        <section id="clipping-panel" class="clipping-panel" hidden><div class="clipping-title"><strong>显示剖切</strong><button id="clipping-close" title="关闭面板">×</button></div><p>仅影响三维预览，不改变 ICP 输入、RMS 或最终矩阵。</p>
          <div class="clipping-control-switch" role="group" aria-label="剖切模式"><button data-clipping-control="joint" class="active">联合剖切</button><button data-clipping-control="independent">独立剖切</button></div>
          <div id="joint-clipping">
            <label>剖切方式<select id="clipping-mode"><option value="off">关闭</option><option value="axis">坐标轴</option><option value="box">长方体</option></select></label>
            <label>作用模型<select id="clipping-scope"><option value="both">模型 A 和 B</option><option value="a">仅模型 A</option><option value="b">仅模型 B</option></select></label>
            <div id="axis-clipping" hidden><div class="axis-clipping-grid">${['x', 'y', 'z'].map(axis => `<strong>${axis.toUpperCase()}</strong><label><input id="clip-${axis}-min-enabled" type="checkbox">最小</label><input id="clip-${axis}-min" type="number" step="0.01"><label><input id="clip-${axis}-max-enabled" type="checkbox">最大</label><input id="clip-${axis}-max" type="number" step="0.01">`).join('')}</div><button id="axis-reset">重置轴向范围</button></div>
            <div id="box-clipping" hidden><p class="clip-mode-hint">中心手柄可轴向／平面平移；仅拖动圆环时旋转。六个贴面箭头用于单独调整对应剖切面。</p><div class="clip-tool-row"><button id="clip-fit-a">适配 A</button><button id="clip-fit-b">适配 B</button><button id="clip-fit-all">适配全部</button></div></div>
            <label class="clip-helper-option"><input id="clip-helper-visible" type="checkbox" checked>显示剖切辅助体与手柄</label>
            <button id="clipping-clear" class="full-width">清除联合剖切</button>
          </div>
          <div id="independent-clipping" hidden>
            <div class="independent-editor-switch" role="group" aria-label="当前编辑模型"><button data-clip-editor="a" class="active">编辑 A</button><button data-clip-editor="b">编辑 B</button></div>
            ${(['a','b'] as const).map(model => `<fieldset class="independent-clip-model" data-independent-model="${model}"><legend>模型 ${model.toUpperCase()}</legend>
              <label>剖切方式<select id="ind-${model}-mode"><option value="off">关闭</option><option value="axis">坐标轴</option><option value="box">长方体</option></select></label>
              <div data-independent-axis="${model}" hidden><div class="axis-clipping-grid">${['x','y','z'].map(axis => `<strong>${axis.toUpperCase()}</strong><label><input id="ind-${model}-${axis}-min-enabled" type="checkbox">最小</label><input id="ind-${model}-${axis}-min" type="number" step="0.01"><label><input id="ind-${model}-${axis}-max-enabled" type="checkbox">最大</label><input id="ind-${model}-${axis}-max" type="number" step="0.01">`).join('')}</div><button data-independent-axis-reset="${model}">重置 ${model.toUpperCase()} 范围</button></div>
              <div data-independent-box="${model}" hidden><p class="clip-mode-hint">选择「编辑 ${model.toUpperCase()}」后可使用中心和六面手柄。</p><button data-independent-fit="${model}">适配模型 ${model.toUpperCase()}</button></div>
              <label class="clip-helper-option"><input id="ind-${model}-helper-visible" type="checkbox" checked>显示 ${model.toUpperCase()} 辅助体</label>
              <button data-independent-clear="${model}" class="full-width">清除模型 ${model.toUpperCase()} 剖切</button>
            </fieldset>`).join('')}
          </div>
        </section>
        <div class="view-gizmo" aria-label="快速视角"><div class="view-cube-scene"><div class="view-cube"><button class="cube-face face-x" data-direction="1,0,0" title="沿 +X 查看">X</button><button class="cube-face face-nx" data-direction="-1,0,0" title="沿 -X 查看">−X</button><button class="cube-face face-y" data-direction="0,1,0" title="沿 +Y 查看">Y</button><button class="cube-face face-ny" data-direction="0,-1,0" title="沿 -Y 查看">−Y</button><button class="cube-face face-z" data-direction="0,0,1" title="顶视图（沿 +Z 查看）">Z</button><button class="cube-face face-nz" data-direction="0,0,-1" title="底视图（沿 -Z 查看）">−Z</button>${[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => `<button class="cube-corner" data-direction="${x},${y},${z}" style="--cx:${x};--cy:${y};--cz:${z}" title="等轴视角 ${x > 0 ? '+' : '−'}X ${y > 0 ? '+' : '−'}Y ${z > 0 ? '+' : '−'}Z"></button>`))).join('')}</div></div><div class="projection-switch"><button data-projection="orthographic">正交</button><button data-projection="perspective" class="active">透视</button></div></div>
        <div id="viewport-help" class="viewport-help">左键空白：旋转　中键：平移　滚轮：缩放　左键平移轴／面：移动模型　左键旋转圆环：旋转模型</div></section>
    </div></main>`;
  mountWorkbenchLayout(root);

  const outputDirection = root.querySelector<HTMLSelectElement>('#output-direction')!;
  const movingSelect = root.querySelector<HTMLSelectElement>('#moving-model')!;
  outputDirection.value = session.output_direction;
  movingSelect.value = session.moving_model;
  const effectiveMoving = (): ModelId => movingSelect.value === 'auto'
    ? session.metadata!.recommended_moving_model : movingSelect.value as ModelId;

  const canvas = root.querySelector<HTMLCanvasElement>('#viewport')!;
  const viewportElement = canvas.parentElement!;
  viewportElement.style.minHeight = '0';
  viewportElement.style.overflow = 'hidden';
  const engine = new RegistrationApplication({ canvas, viewport: viewportElement });
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
  const originPlanes = new OriginPlaneController(root, application, entities,
    { a: infoA.origin as XYZ, b: infoB.origin as XYZ }, modelDiagonals, modelVisible);
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

  const movingTranslateLayer = pc.TranslateGizmo.createLayer(application, 'Moving Model Translation');
  const movingRotateLayer = pc.RotateGizmo.createLayer(application, 'Moving Model Rotation');
  const clipTranslateLayer = pc.TranslateGizmo.createLayer(application, 'Clipping Box Translation');
  const clipRotateLayer = pc.RotateGizmo.createLayer(application, 'Clipping Box Rotation');
  const translate = new pc.TranslateGizmo(camera.camera!, movingTranslateLayer);
  const rotate = new pc.RotateGizmo(camera.camera!, movingRotateLayer);
  const clipTranslate = new pc.TranslateGizmo(camera.camera!, clipTranslateLayer);
  const clipRotate = new pc.RotateGizmo(camera.camera!, clipRotateLayer);
  [translate, clipTranslate].forEach(gizmo => {
    gizmo.axisGap = 0.08; gizmo.axisLineLength = 0.72; gizmo.axisPlaneSize = 0.14; gizmo.axisPlaneGap = 0.22;
  });
  [rotate, clipRotate].forEach(gizmo => { gizmo.centerRadius = 0.001; gizmo.ringTolerance = 0.025; });
  translate.mouseButtons[1] = translate.mouseButtons[2] = false;
  rotate.mouseButtons[1] = rotate.mouseButtons[2] = false;
  clipTranslate.mouseButtons[1] = clipTranslate.mouseButtons[2] = false;
  clipRotate.mouseButtons[1] = clipRotate.mouseButtons[2] = false;
  const clippingState = new ClippingStateController();
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

  const inputs: Record<string, HTMLInputElement> = {};
  for (const [container, prefix, step] of [['position', 'p', '0.01'], ['rotation', 'r', '0.1']] as const) {
    const parent = root.querySelector<HTMLElement>(`#${container}`)!;
    for (const axis of ['x', 'y', 'z']) {
      const label = document.createElement('label'); label.className = 'axis-input';
      const input = document.createElement('input'); input.type = 'number'; input.step = step; input.value = '0';
      input.setAttribute('aria-label', `${container === 'position' ? '平移' : '旋转'} ${axis.toUpperCase()}`);
      const suffix = document.createElement('span'); suffix.textContent = axis.toUpperCase();
      inputs[`${prefix}${axis}`] = input; label.append(input, suffix); parent.appendChild(label);
      input.addEventListener('input', () => {
        const fields = Object.values(inputs);
        if (fields.some(field => field.value === '' || field.validity.badInput || !Number.isFinite(Number(field.value)))) return;
        display.setPose([Number(inputs.px.value), Number(inputs.py.value), Number(inputs.pz.value)],
          [Number(inputs.rx.value), Number(inputs.ry.value), Number(inputs.rz.value)]);
      });
    }
  }

  const refreshRoles = (reset = false) => {
    const moving = effectiveMoving(); const fixed = moving === 'a' ? 'b' : 'a';
    if (reset) display.reset(moving);
    const recolor = (entity: pc.Entity, color: pc.Color) => entity.render!.meshInstances.forEach(instance => {
      (instance.material as PointCloudMaterial).setPointColor(color);
    });
    recolor(entities[moving], new pc.Color(1.0, 0.72, 0.08));
    recolor(entities[fixed], new pc.Color(0.68, 0.72, 0.78));
    root.querySelector<HTMLElement>('#role-hint')!.textContent = `ICP：移动 ${moving.toUpperCase()}，固定 ${fixed.toUpperCase()}。预览与粗配准均使用业务坐标；数值为移动模型业务局部坐标 → 固定模型业务局部坐标。`;
    const rangeRisk = root.querySelector<HTMLElement>('#range-risk')!;
    const rangeRatio = modelDiagonals[fixed] > 0 ? modelDiagonals[moving] / modelDiagonals[fixed] : Number.POSITIVE_INFINITY;
    const movingLarger = rangeRatio >= 1.25;
    rangeRisk.hidden = !movingLarger;
    rangeRisk.textContent = movingLarger
      ? `范围风险：移动模型 ${moving.toUpperCase()} 的包围盒对角线约为固定模型 ${fixed.toUpperCase()} 的 ${rangeRatio.toFixed(1)} 倍。大范围点云匹配小范围点云容易落入错误位置；建议改为移动 ${fixed.toUpperCase()} 匹配 ${moving.toUpperCase()}。最终业务方向无需改变，系统返回的反向矩阵就是所需转换矩阵。`
      : '';
    root.querySelector<HTMLElement>('#badge')!.textContent = `移动 ${moving.toUpperCase()}（黄色）　固定 ${fixed.toUpperCase()}（灰色）`;
    attach();
  };
  movingSelect.addEventListener('change', () => { coordinateQuery?.invalidate(); refreshRoles(true); });
  outputDirection.addEventListener('change', () => { root.querySelector<HTMLElement>('#result')!.hidden = true; });
  refreshRoles();

  const readBusinessTransform = (model: ModelId): TransformParameters => {
    const values = (kind: keyof TransformParameters) => Array.from(root.querySelectorAll<HTMLInputElement>(`[data-business-model="${model}"][data-business-kind="${kind}"]`)).map(input => {
      if (input.validity.badInput) throw new Error('参数必须是有效数字');
      return input.value.trim() === '' ? (kind === 'scale' ? 1 : 0) : Number(input.value);
    }) as XYZ;
    return { translation: values('translation'), rotation_degrees: values('rotation_degrees'), scale: values('scale') };
  };
  const renderBusinessMatrix = (model: ModelId) => {
    const value = readBusinessTransform(model);
    root.querySelector<HTMLElement>(`[data-business-matrix="${model}"]`)!.textContent = matrixText(transformParametersMatrix(value));
  };
  root.querySelectorAll<HTMLInputElement>('[data-business-model]').forEach(input => input.addEventListener('input', () => {
    try { renderBusinessMatrix(input.dataset.businessModel as ModelId); } catch { /* apply reports invalid values */ }
  }));
  const setBusinessInputs = (model: ModelId, value: TransformParameters) => {
    (['translation','rotation_degrees','scale'] as const).forEach(kind => root.querySelectorAll<HTMLInputElement>(`[data-business-model="${model}"][data-business-kind="${kind}"]`).forEach((input,index) => { input.value = String(value[kind][index]); }));
    renderBusinessMatrix(model);
  };
  root.querySelector('#reset-business-transforms')!.addEventListener('click', () => { setBusinessInputs('a', defaultTransform()); setBusinessInputs('b', defaultTransform()); });
  root.querySelector('#save-business-transforms')!.addEventListener('click', async () => {
    const message = root.querySelector<HTMLElement>('#business-transform-status')!;
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
      message.textContent = '已应用。视图已按各模型预变换更新，粗配准及旧 ICP 结果已失效，请重新配准。';
    } catch (error) { if (!signal.aborted) message.textContent = `应用失败：${String(error)}`; }
  });

  let clippingHandles: ClippingHandles | null = null;
  application.on('update', () => {
    if (resultSignature && resultSignature !== display.signature()) {
      root.querySelector<HTMLElement>('#result')!.hidden = true;
      resultSignature = '';
    }
    const pose = display.getPose();
    const values = [...pose.position, ...pose.rotation];
    ['px', 'py', 'pz', 'rx', 'ry', 'rz'].forEach((key, index) => { if (document.activeElement !== inputs[key]) inputs[key].value = values[index].toFixed(3); });
    root.querySelector<HTMLElement>('#initial-matrix')!.textContent = matrixText(display.getMovingLocalToFixedLocal());
    clippingScene?.sync();
    clippingScene?.drawHelpers();
    clippingHandles?.update();
  });

  const resetButton = root.querySelector<HTMLButtonElement>('#reset')!;
  const clippingToggle = root.querySelector<HTMLButtonElement>('#clipping-toggle')!;
  const clippingPanel = root.querySelector<HTMLElement>('#clipping-panel')!;
  const originPlanePanel = root.querySelector<HTMLElement>('.origin-planes-panel')!;
  const clippingMode = root.querySelector<HTMLSelectElement>('#clipping-mode')!;
  const clippingScope = root.querySelector<HTMLSelectElement>('#clipping-scope')!;
  const axisClipping = root.querySelector<HTMLElement>('#axis-clipping')!;
  const boxClipping = root.querySelector<HTMLElement>('#box-clipping')!;
  const clipHelperVisible = root.querySelector<HTMLInputElement>('#clip-helper-visible')!;
  const jointClipping = root.querySelector<HTMLElement>('#joint-clipping')!;
  const independentClipping = root.querySelector<HTMLElement>('#independent-clipping')!;
  const controlButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-clipping-control]'));
  const editorButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-clip-editor]'));
  const independentModes: Record<ModelId, HTMLSelectElement> = {
    a: root.querySelector<HTMLSelectElement>('#ind-a-mode')!, b: root.querySelector<HTMLSelectElement>('#ind-b-mode')!,
  };
  const independentHelperInputs: Record<ModelId, HTMLInputElement> = {
    a: root.querySelector<HTMLInputElement>('#ind-a-helper-visible')!, b: root.querySelector<HTMLInputElement>('#ind-b-helper-visible')!,
  };
  resetButton.addEventListener('click', () => { if (!running) display.reset(effectiveMoving()); });
  root.querySelector('#fit')!.addEventListener('click', () => cameraController.fit());
  clippingToggle.addEventListener('click', () => {
    clippingPanel.hidden = !clippingPanel.hidden;
    if (!clippingPanel.hidden) originPlanePanel.hidden = true;
    refreshClippingMode();
  });
  root.querySelector('#clipping-close')!.addEventListener('click', () => { clippingPanel.hidden = true; clippingInteractionActive = false; attach(); });

  const axisInputs = Object.fromEntries(['x', 'y', 'z'].flatMap(axis => [
    [`${axis}MinEnabled`, root.querySelector<HTMLInputElement>(`#clip-${axis}-min-enabled`)!],
    [`${axis}Min`, root.querySelector<HTMLInputElement>(`#clip-${axis}-min`)!],
    [`${axis}MaxEnabled`, root.querySelector<HTMLInputElement>(`#clip-${axis}-max-enabled`)!],
    [`${axis}Max`, root.querySelector<HTMLInputElement>(`#clip-${axis}-max`)!],
  ])) as Record<string, HTMLInputElement>;
  const independentAxisInputs = Object.fromEntries((['a', 'b'] as ModelId[]).map(model => [model, Object.fromEntries(['x', 'y', 'z'].flatMap(axis => [
    [`${axis}MinEnabled`, root.querySelector<HTMLInputElement>(`#ind-${model}-${axis}-min-enabled`)!],
    [`${axis}Min`, root.querySelector<HTMLInputElement>(`#ind-${model}-${axis}-min`)!],
    [`${axis}MaxEnabled`, root.querySelector<HTMLInputElement>(`#ind-${model}-${axis}-max-enabled`)!],
    [`${axis}Max`, root.querySelector<HTMLInputElement>(`#ind-${model}-${axis}-max`)!],
  ]))])) as Record<ModelId, Record<string, HTMLInputElement>>;
  const originalBounds = (() => {
    const min = new pc.Vec3(Math.min(cloudA.min.x, cloudB.min.x), Math.min(cloudA.min.y, cloudB.min.y), Math.min(cloudA.min.z, cloudB.min.z));
    const max = new pc.Vec3(Math.max(cloudA.max.x, cloudB.max.x), Math.max(cloudA.max.y, cloudB.max.y), Math.max(cloudA.max.z, cloudB.max.z));
    return { min, max };
  })();
  const resetAxisInputSet = (target: Record<string, HTMLInputElement>, bounds: { min: pc.Vec3; max: pc.Vec3 }) => {
    ['x', 'y', 'z'].forEach(axis => {
      target[`${axis}MinEnabled`].checked = false;
      target[`${axis}MaxEnabled`].checked = false;
      target[`${axis}Min`].value = bounds.min[axis as 'x' | 'y' | 'z'].toFixed(3);
      target[`${axis}Max`].value = bounds.max[axis as 'x' | 'y' | 'z'].toFixed(3);
    });
  };
  const resetAxisInputs = () => resetAxisInputSet(axisInputs, originalBounds);
  resetAxisInputs();
  (['a', 'b'] as ModelId[]).forEach(model => resetAxisInputSet(independentAxisInputs[model], originalBounds));
  root.querySelector('#axis-reset')!.addEventListener('click', resetAxisInputs);
  const axisClipState = (target: Record<string, HTMLInputElement>) => ({
    min: new pc.Vec3(Number(target.xMin.value), Number(target.yMin.value), Number(target.zMin.value)),
    max: new pc.Vec3(Number(target.xMax.value), Number(target.yMax.value), Number(target.zMax.value)),
    minEnabled: Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, target[`${axis}MinEnabled`].checked])) as Record<ClipAxis, boolean>,
    maxEnabled: Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, target[`${axis}MaxEnabled`].checked])) as Record<ClipAxis, boolean>,
  });
  const getAxisClipState = () => axisClipState(axisInputs);
  const setAxisBoundaryIn = (target: Record<string, HTMLInputElement>, axis: ClipAxis, side: ClipSide, value: number) => {
    const opposite = side === 'min' ? 'max' : 'min';
    const oppositeEnabled = target[`${axis}${opposite === 'min' ? 'Min' : 'Max'}Enabled`].checked;
    const oppositeValue = Number(target[`${axis}${opposite === 'min' ? 'Min' : 'Max'}`].value);
    const bounded = oppositeEnabled ? (side === 'min' ? Math.min(value, oppositeValue) : Math.max(value, oppositeValue)) : value;
    target[`${axis}${side === 'min' ? 'Min' : 'Max'}`].value = bounded.toFixed(3);
    target[`${axis}${side === 'min' ? 'Min' : 'Max'}Enabled`].checked = true;
  };
  const setAxisBoundary = (axis: ClipAxis, side: ClipSide, value: number) => setAxisBoundaryIn(axisInputs, axis, side, value);
  for (const axis of ['x', 'y', 'z'] as ClipAxis[]) for (const side of ['min', 'max'] as ClipSide[]) {
    axisInputs[`${axis}${side === 'min' ? 'Min' : 'Max'}`].addEventListener('change', event => {
      setAxisBoundary(axis, side, Number((event.currentTarget as HTMLInputElement).value));
    });
    for (const model of ['a', 'b'] as ModelId[]) independentAxisInputs[model][`${axis}${side === 'min' ? 'Min' : 'Max'}`].addEventListener('change', event => {
      setAxisBoundaryIn(independentAxisInputs[model], axis, side, Number((event.currentTarget as HTMLInputElement).value));
    });
  }
  clippingScene = new ClippingSceneController({
    app: application,
    state: clippingState,
    jointBox: clipBox,
    independentBoxes: independentClipBoxes,
    pointMaterials,
    gaussian: gaussianController,
    scope: () => clippingScope.value as 'both' | ModelId,
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
  root.querySelector('#clip-fit-a')!.addEventListener('click', () => fitClipBox(['a']));
  root.querySelector('#clip-fit-b')!.addEventListener('click', () => fitClipBox(['b']));
  root.querySelector('#clip-fit-all')!.addEventListener('click', () => fitClipBox(['a', 'b']));
  (['a', 'b'] as ModelId[]).forEach(model => root.querySelector(`[data-independent-fit="${model}"]`)!.addEventListener('click', () => fitClipBox([model], independentClipBoxes[model])));
  const refreshClippingMode = () => {
    clippingState.jointMode = clippingMode.value as typeof clippingState.jointMode;
    clippingState.jointHelperVisible = clipHelperVisible.checked;
    (['a', 'b'] as ModelId[]).forEach(model => {
      clippingState.independentModes[model] = independentModes[model].value as typeof clippingState.independentModes[ModelId];
      clippingState.independentHelpers[model] = independentHelperInputs[model].checked;
      root.querySelector<HTMLElement>(`[data-independent-axis="${model}"]`)!.hidden = clippingState.independentModes[model] !== 'axis';
      root.querySelector<HTMLElement>(`[data-independent-box="${model}"]`)!.hidden = clippingState.independentModes[model] !== 'box';
      independentClipBoxes[model].enabled = clippingState.controlMode === 'independent'
        && clippingState.independentModes[model] === 'box' && clippingState.independentHelpers[model];
    });
    jointClipping.hidden = clippingState.controlMode !== 'joint'; independentClipping.hidden = clippingState.controlMode !== 'independent';
    controlButtons.forEach(button => button.classList.toggle('active', button.dataset.clippingControl === clippingState.controlMode));
    editorButtons.forEach(button => button.classList.toggle('active', button.dataset.clipEditor === clippingState.editor));
    root.querySelectorAll<HTMLElement>('[data-independent-model]').forEach(fieldset => fieldset.classList.toggle('active-editor', fieldset.dataset.independentModel === clippingState.editor));
    const clippingEnabled = clippingState.enabled();
    clippingToggle.classList.toggle('active', clippingEnabled);
    clippingToggle.setAttribute('aria-pressed', String(clippingEnabled));
    clippingToggle.title = `${clippingState.summary()}；点击打开或关闭剖切面板`;
    gaussianController.refreshStatus();
    const editedMode = clippingState.editedMode();
    clippingInteractionActive = !clippingPanel.hidden && editedMode !== 'off';
    axisClipping.hidden = clippingState.jointMode !== 'axis'; boxClipping.hidden = clippingState.jointMode !== 'box';
    clipBox.enabled = clippingState.controlMode === 'joint' && clippingState.jointMode === 'box' && clippingState.jointHelperVisible;
    attach();
    root.querySelector<HTMLElement>('#viewport-help')!.textContent = editedMode === 'box'
      ? '左键空白：旋转　中键：平移　滚轮：缩放　左键手柄：调整剖切长方体'
      : '左键空白：旋转　中键：平移　滚轮：缩放　左键平移轴／面：移动模型　左键旋转圆环：旋转模型';
  };
  clippingMode.addEventListener('change', refreshClippingMode);
  clipHelperVisible.addEventListener('change', () => {
    clipBox.enabled = clippingMode.value === 'box' && clipHelperVisible.checked;
    attach();
  });
  root.querySelector('#clipping-clear')!.addEventListener('click', () => {
    clippingMode.value = 'off'; resetAxisInputs(); fitClipBox(['a', 'b']); refreshClippingMode();
  });
  controlButtons.forEach(button => button.addEventListener('click', () => {
    clippingState.controlMode = button.dataset.clippingControl as typeof clippingState.controlMode; refreshClippingMode();
  }));
  editorButtons.forEach(button => button.addEventListener('click', () => {
    clippingState.editor = button.dataset.clipEditor as ModelId; refreshClippingMode();
  }));
  (['a', 'b'] as ModelId[]).forEach(model => {
    independentModes[model].addEventListener('change', refreshClippingMode);
    independentHelperInputs[model].addEventListener('change', refreshClippingMode);
    root.querySelector(`[data-independent-axis-reset="${model}"]`)!.addEventListener('click', () => resetAxisInputSet(independentAxisInputs[model], originalBounds));
    root.querySelector(`[data-independent-clear="${model}"]`)!.addEventListener('click', () => {
      independentModes[model].value = 'off'; resetAxisInputSet(independentAxisInputs[model], originalBounds);
      fitClipBox([model], independentClipBoxes[model]); refreshClippingMode();
    });
  });
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
      if (coordinateQuery?.active && (coordinateQuery.hovered || coordinateQuery.dragging) && event.button === 0) return true;
      return clippingHandles?.pointerDown(event) ?? false;
    },
    pointerUp: event => {
      clippingHandles?.pointerUp(event);
      clippingScene?.sync(true);
    },
    navigationBlocked: event => {
      const clipGizmoHovered = clipTranslateHovered || clipRotateHovered;
      const gizmoHovered = clippingInteractionActive ? clipGizmoHovered : (translateGizmoHovered || rotateGizmoHovered);
      return event.button === 2 || gizmoTransforming || (event.button === 0 && gizmoHovered);
    },
    dragBlocked: () => gizmoTransforming || Boolean(coordinateQuery?.dragging),
  });

  const resultState = shallowReactive<{ result: RegistrationResult | null; direction: string }>({
    result: null, direction: 'a_to_b',
  });
  const resultApp = createApp({ render: () => h(RegistrationResultPanel, resultState) });
  resultApp.mount(root.querySelector<HTMLElement>('#result')!);
  const icpValues = reactive<Record<string, string>>({
    min_rms_decrease: '0.00001', sampling_limit: '50000', overlap: '1', random_seed: '42',
  });
  const icpState = shallowReactive({ disabled: false });
  const icpApp = createApp({ render: () => h(IcpParameters, {
    values: icpValues, disabled: icpState.disabled,
    onChange: (key: string, value: string) => { icpValues[key] = value; },
  }) });
  icpApp.mount(root.querySelector<HTMLElement>('#icp-parameters')!);
  const actionState = shallowReactive({ running: false, locked: false, cancelling: false, progress: false });
  const iterationProgress = root.querySelector<HTMLElement>('#iteration-progress')!;
  const progressToolbar = root.querySelector<HTMLElement>('.viewport-toolbar')!;
  const positionProgress = () => {
    const top = progressToolbar.offsetTop + progressToolbar.offsetHeight + 8;
    iterationProgress.style.top = `${top}px`;
    const panelTop = top + (iterationProgress.hidden ? 0 : iterationProgress.offsetHeight + 8);
    clippingPanel.style.top = `${panelTop}px`;
    clippingPanel.style.maxHeight = `calc(100% - ${panelTop + 12}px)`;
    originPlanePanel.style.top = `${panelTop}px`;
    originPlanePanel.style.maxHeight = `calc(100% - ${panelTop + 12}px)`;
  };
  const progressResize = new ResizeObserver(positionProgress);
  progressResize.observe(progressToolbar);
  progressResize.observe(iterationProgress);
  positionProgress();
  const registrationControls = [outputDirection, movingSelect, resetButton,
    ...Object.values(inputs),
    ...Array.from(root.querySelectorAll<HTMLInputElement>('[data-business-model]')),
    root.querySelector<HTMLButtonElement>('#save-business-transforms')!, root.querySelector<HTMLButtonElement>('#reset-business-transforms')!];
  let latestProgressIteration = 0;
  const setRunning = (value: boolean) => {
    running = value;
    icpState.disabled = value || queryActive;
    actionState.running = value;
    actionState.cancelling = false;
    registrationControls.forEach(control => { control.disabled = value || queryActive; });
    actionState.locked = queryActive;
    attach();
  };
  coordinateQuery = new CoordinateQuery({
    root, app: application, camera, canvas, entities, clouds, sessionId,
    origins: { a: infoA.origin as XYZ, b: infoB.origin as XYZ }, businessMatrices: display.businessMatrices, diagonal: bounds.diagonal,
    localToDisplay: model => display.localToDisplay(model),
    signature: () => display.signature(),
    setOriginal: original => { display.setOriginal(original); cameraController.fit(); },
    lock: active => {
      queryActive = active;
      icpState.disabled = active || running;
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
    resultState.direction = outputDirection.value;
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
        output_direction: outputDirection.value as RegistrationRequest['output_direction'],
        moving_model: movingSelect.value as RegistrationRequest['moving_model'],
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

  const latest = session.registrations?.at(-1);
  if (latest?.status === 'succeeded' && latest.result_url) {
    const signature = display.signature();
    try {
      const response = await fetch(latest.result_url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json() as RegistrationResult;
      const matching = result.coordinate_space === 'business' && (['a', 'b'] as ModelId[]).every(model => {
        const matrix = result.business_transforms?.[model].matrix ?? transformParametersMatrix(defaultTransform());
        return matrix.flat().every((value, index) => Math.abs(value-display.businessMatrices[model].flat()[index]) < 1e-12);
      });
      if (matching && signature === display.signature() && !running) {
        movingSelect.value = result.moving_model;
        outputDirection.value = latest.output_direction;
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
  let destroyed = false;
  return () => {
    if (destroyed) return;
    destroyed = true;
    resultApp.unmount();
    icpApp.unmount();
    actionsApp.unmount();
    lifecycle.abort();
    externalSignal?.removeEventListener('abort', abortLifecycle);
    jobController.destroy();
    progressResize.disconnect();
    coordinateQuery?.destroy();
    originPlanes.destroy();
    clippingHandles?.destroy();
    gaussianController.destroy();
    toolManager.destroy();
    translate.destroy();
    rotate.destroy();
    clipTranslate.destroy();
    clipRotate.destroy();
    inputController.destroy();
    cameraController.destroy();
    engine.destroy();
  };
}
