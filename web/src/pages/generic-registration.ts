import * as pc from 'playcanvas';
import { ClippingHandles, type ClipAxis, type ClipSide } from '../clipping-handles';
import { createPointCloudEntity, loadPreview, type PointCloudMaterial, type PreviewCloud } from '../point-cloud';
import '../workspace.css';
import '../view-gizmo.css';

type Matrix4 = number[][];
type ModelId = 'a' | 'b';

interface SessionStatus {
  status: string;
  error?: string;
  output_direction: 'a_to_b' | 'b_to_a';
  moving_model: 'auto' | ModelId;
  model_a_preview_url?: string;
  model_b_preview_url?: string;
  gaussian_a_url?: string;
  gaussian_b_url?: string;
  inputs?: { model_a_bytes?: number; model_b_bytes?: number };
  metadata?: {
    recommended_moving_model: ModelId;
    models: Record<ModelId, {
      format: string; source_point_count: number; preview_point_count: number; origin: number[];
    }>;
  };
}

interface RegistrationResult {
  recommended_matrix: { name: string; formula: string; value: Matrix4 };
  moving_model: ModelId;
  moving_local_to_fixed_local: Matrix4;
  a_to_b: Matrix4;
  b_to_a: Matrix4;
  metrics: { final_rms: number; final_point_count: number; elapsed_seconds: number };
}

interface IterationEvent {
  type: 'iteration';
  iteration: number;
  rms: number;
  point_count: number;
  elapsed_seconds: number;
  moving_local_to_fixed_local: Matrix4;
}

const identity = (): Matrix4 => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const matrixText = (matrix: Matrix4) => matrix.map(row => row.map(value => value.toFixed(12)).join(' ')).join('\n');
const formatBytes = (bytes?: number) => bytes
  ? `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
  : '大小未知';

function entityMatrix(entity: pc.Entity): Matrix4 {
  const data = entity.getWorldTransform().data;
  return Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => Number(data[column * 4 + row])));
}

function applyMatrix(entity: pc.Entity, matrix: Matrix4): void {
  const transform = new pc.Mat4();
  transform.set(Array.from({ length: 16 }, (_, index) => matrix[index % 4][Math.floor(index / 4)]));
  entity.setLocalPosition(transform.getTranslation());
  entity.setLocalEulerAngles(transform.getEulerAngles());
}

function boundsOf(a: PreviewCloud, b: PreviewCloud): { center: pc.Vec3; diagonal: number } {
  const min = new pc.Vec3(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z));
  const max = new pc.Vec3(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z));
  return { center: min.clone().add(max).mulScalar(0.5), diagonal: max.clone().sub(min).length() };
}

function cloudDiagonal(cloud: PreviewCloud): number {
  return cloud.max.clone().sub(cloud.min).length();
}

async function waitForSession(sessionId: string, statusElement: HTMLElement): Promise<SessionStatus> {
  while (true) {
    const response = await fetch(`/api/v2/registration-sessions/${sessionId}`);
    const status = await response.json() as SessionStatus;
    statusElement.textContent = `预览状态：${status.status}`;
    if (status.status === 'ready') return status;
    if (status.status === 'failed') throw new Error(status.error ?? '预览生成失败');
    await sleep(1000);
  }
}

export async function renderGenericRegistration(root: HTMLElement, sessionId: string): Promise<void> {
  root.innerHTML = '<main class="loading"><h2>正在生成双模型预览</h2><pre id="loading-status">queued</pre></main>';
  const session = await waitForSession(sessionId, root.querySelector('#loading-status')!);
  const [cloudA, cloudB] = await Promise.all([
    loadPreview(session.model_a_preview_url!), loadPreview(session.model_b_preview_url!),
  ]);
  const infoA = session.metadata!.models.a;
  const infoB = session.metadata!.models.b;
  root.innerHTML = `
    <main class="editor integrated-editor"><div class="workspace integrated-workspace">
      <aside class="panel workflow-panel">
        <div class="workflow-title"><div><h1>通用点云双向配准</h1><small>A：${infoA.format.toUpperCase()}　B：${infoB.format.toUpperCase()}</small></div><button id="new-task">新建</button></div>
        <section class="workflow-step completed"><h2><span>1</span> 模型</h2><p>A：${infoA.source_point_count.toLocaleString()} 点<br>B：${infoB.source_point_count.toLocaleString()} 点</p><p id="badge" class="model-role-summary"></p><p id="gaussian-status" class="gaussian-status" hidden></p></section>
        <section class="workflow-step"><h2><span>2</span> 方向与粗配准</h2>
          <div class="role-grid">
            <label class="parameter-label">最终业务矩阵<select id="output-direction"><option value="a_to_b">模型 A → 模型 B</option><option value="b_to_a">模型 B → 模型 A</option></select></label>
            <label class="parameter-label">ICP 移动模型<select id="moving-model"><option value="auto">自动推荐（${session.metadata!.recommended_moving_model.toUpperCase()}）</option><option value="a">移动模型 A</option><option value="b">移动模型 B</option></select></label>
          </div>
          <p id="role-hint" class="step-hint"></p><p id="range-risk" class="range-risk" hidden></p>
          <h3>平移／m</h3><div class="field-grid" id="position"></div>
          <h3>旋转／°</h3><div class="field-grid" id="rotation"></div>
          <details><summary>初始 moving-local→fixed-local</summary><pre id="initial-matrix" class="matrix"></pre></details>
        </section>
        <section class="workflow-step"><h2><span>3</span> ICP 参数</h2><div class="icp-grid">
          <label>RMS 阈值<input id="min-rms" type="number" value="0.00001" step="0.000001"></label>
          <label>采样上限<input id="sampling-limit" type="number" value="50000" step="1000"></label>
          <label>重叠率<input id="overlap" type="number" value="1" min="0.01" max="1" step="0.01"></label>
          <label>随机种子<input id="random-seed" type="number" value="42" min="0" step="1"></label>
        </div><label class="progress-option"><input id="show-registration-progress" type="checkbox">在三维场景中显示配准过程</label><div class="registration-actions"><button id="register" class="primary">执行 ICP 精配准</button><button id="cancel-registration" class="cancel-action" hidden>终止任务</button></div></section>
        <section class="workflow-step"><h2><span>4</span> 结果</h2><pre id="job-status" class="status timeline">尚未提交</pre>
          <section id="result" class="result" hidden><h3 id="result-title"></h3><p id="result-formula" class="result-formula"></p><pre id="result-matrix" class="matrix"></pre><div id="result-metrics"></div><button id="copy-result" class="full-width">复制最终业务矩阵</button><details><summary>查看反向矩阵</summary><pre id="inverse-matrix" class="matrix"></pre><button id="copy-inverse" class="full-width">复制反向矩阵</button></details></section>
        </section>
      </aside>
      <section class="viewport"><canvas id="viewport"></canvas><div class="viewport-toolbar toolbar"><strong>粗配准</strong><button id="reset" title="清除当前移动模型的平移和旋转，恢复到模型刚加载时的位置">重置粗配准</button><button id="fit">适应全部</button><button id="clipping-toggle">剖切</button><div class="model-visibility" aria-label="模型显示控制"><button id="toggle-model-a" class="active">A：显示</button><button id="toggle-model-b" class="active">B：显示</button><button id="gaussian-model-a" class="gaussian-toggle${session.gaussian_a_url ? ' available' : ''}" ${session.gaussian_a_url ? '' : 'disabled'} title="${session.gaussian_a_url ? `加载模型 A 原始 Gaussian（${formatBytes(session.inputs?.model_a_bytes)}）` : '模型 A 不包含完整 Gaussian 属性'}">A：${session.gaussian_a_url ? '显示原高斯' : '无高斯数据'}</button><button id="gaussian-model-b" class="gaussian-toggle${session.gaussian_b_url ? ' available' : ''}" ${session.gaussian_b_url ? '' : 'disabled'} title="${session.gaussian_b_url ? `加载模型 B 原始 Gaussian（${formatBytes(session.inputs?.model_b_bytes)}）` : '模型 B 不包含完整 Gaussian 属性'}">B：${session.gaussian_b_url ? '显示原高斯' : '无高斯数据'}</button></div></div><div id="iteration-progress" class="viewport-progress" hidden></div>
        <section id="clipping-panel" class="clipping-panel" hidden><div class="clipping-title"><strong>显示剖切</strong><button id="clipping-close" title="关闭面板">×</button></div><p>仅影响三维预览，不改变 ICP 输入、RMS 或最终矩阵。</p>
          <label>剖切方式<select id="clipping-mode"><option value="off">关闭</option><option value="axis">坐标轴</option><option value="box">长方体</option></select></label>
          <label>作用模型<select id="clipping-scope"><option value="both">模型 A 和 B</option><option value="a">仅模型 A</option><option value="b">仅模型 B</option></select></label>
          <div id="axis-clipping" hidden><div class="axis-clipping-grid">${['x', 'y', 'z'].map(axis => `<strong>${axis.toUpperCase()}</strong><label><input id="clip-${axis}-min-enabled" type="checkbox">最小</label><input id="clip-${axis}-min" type="number" step="0.01"><label><input id="clip-${axis}-max-enabled" type="checkbox">最大</label><input id="clip-${axis}-max" type="number" step="0.01">`).join('')}</div><button id="axis-reset">重置轴向范围</button></div>
          <div id="box-clipping" hidden><p class="clip-mode-hint">中心手柄可轴向／平面平移；仅拖动圆环时旋转。六个贴面箭头用于单独调整对应剖切面。</p><div class="clip-tool-row"><button id="clip-fit-a">适配 A</button><button id="clip-fit-b">适配 B</button><button id="clip-fit-all">适配全部</button></div></div>
          <label class="clip-helper-option"><input id="clip-helper-visible" type="checkbox" checked>显示剖切辅助体与手柄</label>
          <button id="clipping-clear" class="full-width">清除全部剖切</button>
        </section>
        <div class="view-gizmo" aria-label="快速视角"><div class="view-cube-scene"><div class="view-cube"><button class="cube-face face-x" data-direction="1,0,0" title="沿 +X 查看">X</button><button class="cube-face face-nx" data-direction="-1,0,0" title="沿 -X 查看">−X</button><button class="cube-face face-y" data-direction="0,1,0" title="沿 +Y 查看">Y</button><button class="cube-face face-ny" data-direction="0,-1,0" title="沿 -Y 查看">−Y</button><button class="cube-face face-z" data-direction="0,0,1" title="顶视图（沿 +Z 查看）">Z</button><button class="cube-face face-nz" data-direction="0,0,-1" title="底视图（沿 -Z 查看）">−Z</button>${[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => `<button class="cube-corner" data-direction="${x},${y},${z}" style="--cx:${x};--cy:${y};--cz:${z}" title="等轴视角 ${x > 0 ? '+' : '−'}X ${y > 0 ? '+' : '−'}Y ${z > 0 ? '+' : '−'}Z"></button>`))).join('')}</div></div><div class="projection-switch"><button data-projection="orthographic">正交</button><button data-projection="perspective" class="active">透视</button></div></div>
        <div id="viewport-help" class="viewport-help">左键空白：旋转　中键：平移　滚轮：缩放　左键平移轴／面：移动模型　左键旋转圆环：旋转模型</div></section>
    </div></main>`;

  const outputDirection = root.querySelector<HTMLSelectElement>('#output-direction')!;
  const movingSelect = root.querySelector<HTMLSelectElement>('#moving-model')!;
  outputDirection.value = session.output_direction;
  movingSelect.value = session.moving_model;
  const effectiveMoving = (): ModelId => movingSelect.value === 'auto'
    ? session.metadata!.recommended_moving_model : movingSelect.value as ModelId;

  const canvas = root.querySelector<HTMLCanvasElement>('#viewport')!;
  const keyboard = new pc.Keyboard(window);
  const application = new pc.Application(canvas, { mouse: new pc.Mouse(canvas), touch: new pc.TouchDevice(canvas), keyboard });
  application.setCanvasResolution(pc.RESOLUTION_AUTO); application.start();
  application.scene.gsplat.alphaClip = 0.1;
  const camera = new pc.Entity('Camera');
  camera.addComponent('camera', { clearColor: new pc.Color(0.035, 0.055, 0.085), farClip: 100000, toneMapping: pc.TONEMAP_ACES });
  application.root.addChild(camera);
  const entityA = createPointCloudEntity(application, cloudA, new pc.Color(0.68, 0.72, 0.78), 'Model A');
  const entityB = createPointCloudEntity(application, cloudB, new pc.Color(0.68, 0.72, 0.78), 'Model B');
  application.root.addChild(entityA); application.root.addChild(entityB);
  const entities = { a: entityA, b: entityB };
  const clouds = { a: cloudA, b: cloudB };
  const pointMaterials: Record<ModelId, PointCloudMaterial> = {
    a: entityA.render!.meshInstances[0].material as PointCloudMaterial,
    b: entityB.render!.meshInstances[0].material as PointCloudMaterial,
  };
  const clipBox = new pc.Entity('Clipping Box');
  clipBox.addComponent('render', { type: 'box' });
  const clipBoxMaterial = new pc.StandardMaterial();
  clipBoxMaterial.diffuse = new pc.Color(0.12, 0.82, 0.68);
  clipBoxMaterial.emissive = new pc.Color(0.04, 0.24, 0.20);
  clipBoxMaterial.opacity = 0.055;
  clipBoxMaterial.blendType = pc.BLEND_NORMAL;
  clipBoxMaterial.depthWrite = false;
  clipBoxMaterial.update();
  clipBox.render!.meshInstances.forEach(instance => { instance.material = clipBoxMaterial; });
  application.root.addChild(clipBox);
  clipBox.enabled = false;
  const modelVisible: Record<ModelId, boolean> = { a: true, b: true };
  const gaussianUrls: Record<ModelId, string | undefined> = {
    a: session.gaussian_a_url,
    b: session.gaussian_b_url,
  };
  const gaussianBytes: Record<ModelId, number | undefined> = {
    a: session.inputs?.model_a_bytes,
    b: session.inputs?.model_b_bytes,
  };
  const gaussianDisplays: Record<ModelId, {
    entity: pc.Entity | null; asset: pc.Asset | null; active: boolean; loading: boolean;
  }> = {
    a: { entity: null, asset: null, active: false, loading: false },
    b: { entity: null, asset: null, active: false, loading: false },
  };
  const bounds = boundsOf(cloudA, cloudB);
  const modelDiagonals: Record<ModelId, number> = { a: cloudDiagonal(cloudA), b: cloudDiagonal(cloudB) };
  const cameraTarget = bounds.center.clone();
  let cameraDistance = Math.max(bounds.diagonal * 1.2, 0.1);
  let cameraOrthoHeight = Math.max(bounds.diagonal * 0.6, 0.05);
  const zUp = new pc.Vec3(0, 0, 1);
  const cameraDirection = new pc.Vec3();
  const cameraUp = zUp.clone();
  const setDirectionFromAngles = (yawDegrees: number, pitchDegrees: number) => {
    const yaw = yawDegrees * Math.PI / 180;
    const pitch = pitchDegrees * Math.PI / 180;
    const horizontal = Math.cos(pitch);
    cameraDirection.set(horizontal * Math.sin(yaw), horizontal * Math.cos(yaw), Math.sin(pitch)).normalize();
  };
  setDirectionFromAngles(135, 24);
  const viewCube = root.querySelector<HTMLElement>('.view-cube')!;
  const cubeCorners = Array.from(root.querySelectorAll<HTMLElement>('.cube-corner'));
  const updateCamera = () => {
    camera.setPosition(cameraTarget.clone().add(cameraDirection.clone().mulScalar(cameraDistance)));
    camera.lookAt(cameraTarget, cameraUp);
    const cameraRight = new pc.Vec3().cross(cameraUp, cameraDirection).normalize();
    viewCube.style.transform = `matrix3d(${cameraRight.x},${-cameraUp.x},${cameraDirection.x},0,${cameraRight.y},${-cameraUp.y},${cameraDirection.y},0,${cameraRight.z},${-cameraUp.z},${cameraDirection.z},0,0,0,0,1)`;
    const inverseCubeTransform = `matrix3d(${cameraRight.x},${cameraRight.y},${cameraRight.z},0,${-cameraUp.x},${-cameraUp.y},${-cameraUp.z},0,${cameraDirection.x},${cameraDirection.y},${cameraDirection.z},0,0,0,0,1)`;
    cubeCorners.forEach(corner => {
      const [x, y, z] = corner.dataset.direction!.split(',').map(Number);
      corner.style.transform = `translate3d(${x * 30}px, ${y * -30}px, ${z * 30}px) ${inverseCubeTransform}`;
    });
  };
  const orbitCamera = (horizontalDegrees: number, verticalDegrees: number) => {
    const yawRotation = new pc.Quat().setFromAxisAngle(cameraUp, -horizontalDegrees);
    yawRotation.transformVector(cameraDirection, cameraDirection).normalize();
    const right = new pc.Vec3().cross(cameraUp, cameraDirection).normalize();
    const pitchRotation = new pc.Quat().setFromAxisAngle(right, -verticalDegrees);
    pitchRotation.transformVector(cameraDirection, cameraDirection).normalize();
    pitchRotation.transformVector(cameraUp, cameraUp).normalize();
    updateCamera();
  };
  const fitCamera = () => {
    cameraTarget.copy(bounds.center);
    cameraDistance = Math.max(bounds.diagonal * 1.2, 0.1);
    cameraOrthoHeight = Math.max(bounds.diagonal * 0.6, 0.05);
    camera.camera!.orthoHeight = cameraOrthoHeight;
    setDirectionFromAngles(135, 24);
    cameraUp.copy(zUp);
    updateCamera();
  };
  fitCamera();

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
  let clippingModeValue: 'off' | 'axis' | 'box' = 'off';
  let clippingInteractionActive = false;
  let running = false;
  let gizmoTransforming = false;
  let translateGizmoHovered = false; let rotateGizmoHovered = false;
  let translateGizmoTransforming = false; let rotateGizmoTransforming = false;
  const onTransformStart = () => { gizmoTransforming = true; navigation = null; };
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
  const fixedEntity = () => entities[effectiveMoving() === 'a' ? 'b' : 'a'];
  const attach = () => {
    translate.detach(); rotate.detach(); clipTranslate.detach(); clipRotate.detach();
    if (clippingInteractionActive && clippingModeValue === 'box' && clipHelperVisible.checked) {
      clipTranslate.attach(clipBox);
      clipRotate.attach(clipBox);
    } else if (!clippingInteractionActive && !running && modelVisible[effectiveMoving()]) {
      translate.attach(movingEntity());
      rotate.attach(movingEntity());
    }
  };

  const visibilityButtons: Record<ModelId, HTMLButtonElement> = {
    a: root.querySelector<HTMLButtonElement>('#toggle-model-a')!,
    b: root.querySelector<HTMLButtonElement>('#toggle-model-b')!,
  };
  const setModelVisible = (model: ModelId, visible: boolean) => {
    modelVisible[model] = visible;
    entities[model].enabled = visible;
    visibilityButtons[model].classList.toggle('active', visible);
    visibilityButtons[model].textContent = `${model.toUpperCase()}：${visible ? '显示' : '已隐藏'}`;
    visibilityButtons[model].setAttribute('aria-pressed', String(visible));
    attach();
  };
  (['a', 'b'] as ModelId[]).forEach(model => {
    visibilityButtons[model].addEventListener('click', () => setModelVisible(model, !modelVisible[model]));
    visibilityButtons[model].setAttribute('aria-pressed', 'true');
  });

  const gaussianButtons: Record<ModelId, HTMLButtonElement> = {
    a: root.querySelector<HTMLButtonElement>('#gaussian-model-a')!,
    b: root.querySelector<HTMLButtonElement>('#gaussian-model-b')!,
  };
  const gaussianStatus = root.querySelector<HTMLElement>('#gaussian-status')!;
  const refreshGaussianStatus = (error?: string) => {
    const activeModels = (['a', 'b'] as ModelId[]).filter(model => gaussianDisplays[model].active);
    if (error) {
      gaussianStatus.hidden = false;
      gaussianStatus.classList.add('error');
      gaussianStatus.textContent = error;
      return;
    }
    gaussianStatus.classList.remove('error');
    if (activeModels.length === 0) {
      gaussianStatus.hidden = true;
      gaussianStatus.textContent = '';
      return;
    }
    gaussianStatus.hidden = false;
    const models = activeModels.map(model => model.toUpperCase()).join('、');
    gaussianStatus.textContent = clippingModeValue === 'off'
      ? `模型 ${models} 正在显示完整 Gaussian；该模式仅用于视觉确认，不改变 ICP 输入。`
      : `模型 ${models} 正在显示完整 Gaussian；当前剖切只作用于中心点预览，暂不裁剪 Gaussian。`;
  };
  const releaseGaussian = (model: ModelId) => {
    const display = gaussianDisplays[model];
    display.entity?.destroy();
    if (display.asset) {
      display.asset.unload();
      application.assets.remove(display.asset);
    }
    display.entity = null;
    display.asset = null;
    display.active = false;
    entities[model].render!.enabled = true;
    const button = gaussianButtons[model];
    button.textContent = `${model.toUpperCase()}：显示原高斯`;
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
    button.title = `加载模型 ${model.toUpperCase()} 原始 Gaussian（${formatBytes(gaussianBytes[model])}）`;
  };
  const toggleGaussian = async (model: ModelId) => {
    const url = gaussianUrls[model];
    const display = gaussianDisplays[model];
    const button = gaussianButtons[model];
    if (!url || display.loading) return;
    display.loading = true;
    button.disabled = true;
    try {
      if (display.active) {
        releaseGaussian(model);
        refreshGaussianStatus();
        attach();
        return;
      }
      button.textContent = `${model.toUpperCase()}：Gaussian 加载中…`;
      const asset = new pc.Asset(`Model ${model.toUpperCase()} Original Gaussian PLY`, 'gsplat', {
        url,
        filename: `model-${model}-original-gaussian.ply`,
      });
      display.asset = asset;
      application.assets.add(asset);
      await new Promise<void>((resolve, reject) => {
        asset.ready(() => resolve());
        asset.once('error', (loadError: unknown) => reject(loadError));
        application.assets.load(asset);
      });
      const gaussianEntity = new pc.Entity(`Model ${model.toUpperCase()} Original Gaussian`);
      gaussianEntity.addComponent('gsplat', { asset });
      entities[model].addChild(gaussianEntity);
      display.entity = gaussianEntity;
      display.active = true;
      entities[model].render!.enabled = false;
      button.textContent = `${model.toUpperCase()}：切回中心点`;
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      button.title = `释放模型 ${model.toUpperCase()} Gaussian 并显示中心点`;
      refreshGaussianStatus();
      attach();
    } catch (error) {
      releaseGaussian(model);
      refreshGaussianStatus(`模型 ${model.toUpperCase()} Gaussian 加载失败，已保留中心点：${String(error)}`);
      console.error(error);
    } finally {
      display.loading = false;
      button.disabled = false;
    }
  };
  (['a', 'b'] as ModelId[]).forEach(model => {
    gaussianButtons[model].setAttribute('aria-pressed', 'false');
    gaussianButtons[model].addEventListener('click', () => void toggleGaussian(model));
  });

  const inputs: Record<string, HTMLInputElement> = {};
  for (const [container, prefix, step] of [['position', 'p', '0.01'], ['rotation', 'r', '0.1']] as const) {
    const parent = root.querySelector<HTMLElement>(`#${container}`)!;
    for (const axis of ['x', 'y', 'z']) {
      const label = document.createElement('label'); label.textContent = axis.toUpperCase();
      const input = document.createElement('input'); input.type = 'number'; input.step = step; input.value = '0';
      inputs[`${prefix}${axis}`] = input; label.appendChild(input); parent.appendChild(label);
      input.addEventListener('input', () => {
        movingEntity().setLocalPosition(Number(inputs.px.value), Number(inputs.py.value), Number(inputs.pz.value));
        movingEntity().setLocalEulerAngles(Number(inputs.rx.value), Number(inputs.ry.value), Number(inputs.rz.value));
      });
    }
  }

  const refreshRoles = (reset = false) => {
    const moving = effectiveMoving(); const fixed = moving === 'a' ? 'b' : 'a';
    if (reset) { entityA.setLocalPosition(0, 0, 0); entityA.setLocalEulerAngles(0, 0, 0); entityB.setLocalPosition(0, 0, 0); entityB.setLocalEulerAngles(0, 0, 0); }
    const recolor = (entity: pc.Entity, color: pc.Color) => entity.render!.meshInstances.forEach(instance => {
      (instance.material as PointCloudMaterial).setPointColor(color);
    });
    recolor(entities[moving], new pc.Color(1.0, 0.72, 0.08));
    recolor(entities[fixed], new pc.Color(0.68, 0.72, 0.78));
    root.querySelector<HTMLElement>('#role-hint')!.textContent = `ICP：移动 ${moving.toUpperCase()}，固定 ${fixed.toUpperCase()}。自动模式仅为建议，可手工覆盖。`;
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
  movingSelect.addEventListener('change', () => refreshRoles(true));
  outputDirection.addEventListener('change', () => { root.querySelector<HTMLElement>('#result')!.hidden = true; });
  refreshRoles();

  const clipMinState = new pc.Vec3(); const clipMaxState = new pc.Vec3(); const worldToClipBox = new pc.Mat4();
  const clipCornerLocal: pc.Vec3[] = []; const clipCornerWorld: pc.Vec3[] = [];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
    clipCornerLocal.push(new pc.Vec3(x, y, z)); clipCornerWorld.push(new pc.Vec3());
  }
  const clipEdgeColor = new pc.Color(0.15, 1.0, 0.78);
  let clippingHandles: ClippingHandles | null = null;
  application.on('update', () => {
    const position = movingEntity().getLocalPosition(); const rotation = movingEntity().getLocalEulerAngles();
    const values = [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z];
    ['px', 'py', 'pz', 'rx', 'ry', 'rz'].forEach((key, index) => { if (document.activeElement !== inputs[key]) inputs[key].value = values[index].toFixed(3); });
    root.querySelector<HTMLElement>('#initial-matrix')!.textContent = matrixText(entityMatrix(movingEntity()));
    const currentClipMode = clippingMode.value;
    clipMinState.set(-1e30, -1e30, -1e30); clipMaxState.set(1e30, 1e30, 1e30);
    if (currentClipMode === 'axis') {
      ['x', 'y', 'z'].forEach(axis => {
        const component = axis as 'x' | 'y' | 'z';
        if (axisInputs[`${axis}MinEnabled`].checked) clipMinState[component] = Number(axisInputs[`${axis}Min`].value);
        if (axisInputs[`${axis}MaxEnabled`].checked) clipMaxState[component] = Number(axisInputs[`${axis}Max`].value);
      });
    }
    const scale = clipBox.getLocalScale();
    if (Math.abs(scale.x) < 0.001 || Math.abs(scale.y) < 0.001 || Math.abs(scale.z) < 0.001) {
      clipBox.setLocalScale(Math.max(Math.abs(scale.x), 0.001), Math.max(Math.abs(scale.y), 0.001), Math.max(Math.abs(scale.z), 0.001));
    }
    worldToClipBox.copy(clipBox.getWorldTransform()).invert();
    (['a', 'b'] as ModelId[]).forEach(model => {
      const inScope = clippingScope.value === 'both' || clippingScope.value === model;
      pointMaterials[model].setClipState(currentClipMode !== 'off' && inScope, clipMinState, clipMaxState, currentClipMode === 'box', worldToClipBox);
    });
    if (currentClipMode === 'box' && clipHelperVisible.checked && clippingHandles?.isBoxPresentationVisible()) {
      const transform = clipBox.getWorldTransform();
      clipCornerLocal.forEach((corner, index) => transform.transformPoint(corner, clipCornerWorld[index]));
      for (let index = 0; index < clipCornerWorld.length; index++) for (const bit of [1, 2, 4]) {
        const other = index ^ bit; if (index < other) application.drawLine(clipCornerWorld[index], clipCornerWorld[other], clipEdgeColor, false);
      }
    }
    clippingHandles?.update();
  });

  const resetButton = root.querySelector<HTMLButtonElement>('#reset')!;
  const clippingToggle = root.querySelector<HTMLButtonElement>('#clipping-toggle')!;
  const clippingPanel = root.querySelector<HTMLElement>('#clipping-panel')!;
  const clippingMode = root.querySelector<HTMLSelectElement>('#clipping-mode')!;
  const clippingScope = root.querySelector<HTMLSelectElement>('#clipping-scope')!;
  const axisClipping = root.querySelector<HTMLElement>('#axis-clipping')!;
  const boxClipping = root.querySelector<HTMLElement>('#box-clipping')!;
  const clipHelperVisible = root.querySelector<HTMLInputElement>('#clip-helper-visible')!;
  resetButton.addEventListener('click', () => { if (!running) applyMatrix(movingEntity(), identity()); });
  root.querySelector('#fit')!.addEventListener('click', fitCamera);
  clippingToggle.addEventListener('click', () => {
    clippingPanel.hidden = !clippingPanel.hidden;
    clippingInteractionActive = !clippingPanel.hidden && clippingMode.value !== 'off';
    attach();
  });
  root.querySelector('#clipping-close')!.addEventListener('click', () => { clippingPanel.hidden = true; clippingInteractionActive = false; attach(); });

  const axisInputs = Object.fromEntries(['x', 'y', 'z'].flatMap(axis => [
    [`${axis}MinEnabled`, root.querySelector<HTMLInputElement>(`#clip-${axis}-min-enabled`)!],
    [`${axis}Min`, root.querySelector<HTMLInputElement>(`#clip-${axis}-min`)!],
    [`${axis}MaxEnabled`, root.querySelector<HTMLInputElement>(`#clip-${axis}-max-enabled`)!],
    [`${axis}Max`, root.querySelector<HTMLInputElement>(`#clip-${axis}-max`)!],
  ])) as Record<string, HTMLInputElement>;
  const originalBounds = (() => {
    const min = new pc.Vec3(Math.min(cloudA.min.x, cloudB.min.x), Math.min(cloudA.min.y, cloudB.min.y), Math.min(cloudA.min.z, cloudB.min.z));
    const max = new pc.Vec3(Math.max(cloudA.max.x, cloudB.max.x), Math.max(cloudA.max.y, cloudB.max.y), Math.max(cloudA.max.z, cloudB.max.z));
    return { min, max };
  })();
  const resetAxisInputs = () => {
    ['x', 'y', 'z'].forEach(axis => {
      axisInputs[`${axis}MinEnabled`].checked = false;
      axisInputs[`${axis}MaxEnabled`].checked = false;
      axisInputs[`${axis}Min`].value = originalBounds.min[axis as 'x' | 'y' | 'z'].toFixed(3);
      axisInputs[`${axis}Max`].value = originalBounds.max[axis as 'x' | 'y' | 'z'].toFixed(3);
    });
  };
  resetAxisInputs();
  root.querySelector('#axis-reset')!.addEventListener('click', resetAxisInputs);
  const getAxisClipState = () => ({
    min: new pc.Vec3(Number(axisInputs.xMin.value), Number(axisInputs.yMin.value), Number(axisInputs.zMin.value)),
    max: new pc.Vec3(Number(axisInputs.xMax.value), Number(axisInputs.yMax.value), Number(axisInputs.zMax.value)),
    minEnabled: Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, axisInputs[`${axis}MinEnabled`].checked])) as Record<ClipAxis, boolean>,
    maxEnabled: Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, axisInputs[`${axis}MaxEnabled`].checked])) as Record<ClipAxis, boolean>,
  });
  const setAxisBoundary = (axis: ClipAxis, side: ClipSide, value: number) => {
    const opposite = side === 'min' ? 'max' : 'min';
    const oppositeEnabled = axisInputs[`${axis}${opposite === 'min' ? 'Min' : 'Max'}Enabled`].checked;
    const oppositeValue = Number(axisInputs[`${axis}${opposite === 'min' ? 'Min' : 'Max'}`].value);
    const bounded = oppositeEnabled ? (side === 'min' ? Math.min(value, oppositeValue) : Math.max(value, oppositeValue)) : value;
    axisInputs[`${axis}${side === 'min' ? 'Min' : 'Max'}`].value = bounded.toFixed(3);
    axisInputs[`${axis}${side === 'min' ? 'Min' : 'Max'}Enabled`].checked = true;
  };
  for (const axis of ['x', 'y', 'z'] as ClipAxis[]) for (const side of ['min', 'max'] as ClipSide[]) {
    axisInputs[`${axis}${side === 'min' ? 'Min' : 'Max'}`].addEventListener('change', event => {
      setAxisBoundary(axis, side, Number((event.currentTarget as HTMLInputElement).value));
    });
  }
  clippingHandles = new ClippingHandles(
    application, camera, canvas, clipBox, originalBounds.min, originalBounds.max,
    () => clippingModeValue, getAxisClipState, setAxisBoundary,
    () => clipHelperVisible.checked,
    active => { gizmoTransforming = active; if (active) navigation = null; },
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
  const fitClipBox = (models: ModelId[]) => {
    const target = worldBounds(models); const size = target.max.clone().sub(target.min);
    clipBox.setPosition(target.min.clone().add(target.max).mulScalar(0.5));
    clipBox.setEulerAngles(0, 0, 0);
    clipBox.setLocalScale(Math.max(size.x, 0.001), Math.max(size.y, 0.001), Math.max(size.z, 0.001));
  };
  fitClipBox(['a', 'b']);
  root.querySelector('#clip-fit-a')!.addEventListener('click', () => fitClipBox(['a']));
  root.querySelector('#clip-fit-b')!.addEventListener('click', () => fitClipBox(['b']));
  root.querySelector('#clip-fit-all')!.addEventListener('click', () => fitClipBox(['a', 'b']));
  const refreshClippingMode = () => {
    const current = clippingMode.value as typeof clippingModeValue;
    clippingModeValue = current;
    const clippingEnabled = current !== 'off';
    clippingToggle.classList.toggle('active', clippingEnabled);
    clippingToggle.setAttribute('aria-pressed', String(clippingEnabled));
    clippingToggle.title = clippingEnabled ? '剖切已启用：点击打开或关闭剖切面板' : '打开剖切面板';
    refreshGaussianStatus();
    clippingInteractionActive = !clippingPanel.hidden && current !== 'off';
    axisClipping.hidden = current !== 'axis'; boxClipping.hidden = current !== 'box';
    clipBox.enabled = current === 'box' && clipHelperVisible.checked;
    attach();
    root.querySelector<HTMLElement>('#viewport-help')!.textContent = current === 'box'
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
  refreshClippingMode();
  root.querySelector('#new-task')!.addEventListener('click', () => { location.href = '/'; });

  const setViewDirection = (direction: pc.Vec3) => {
    direction.normalize();
    cameraDirection.copy(direction);
    cameraUp.copy(Math.abs(direction.z) > 0.999 ? pc.Vec3.UP : zUp);
    updateCamera();
  };
  root.querySelectorAll<HTMLButtonElement>('.view-cube button[data-direction]').forEach(button => {
    button.addEventListener('click', () => {
      const [x, y, z] = button.dataset.direction!.split(',').map(Number);
      setViewDirection(new pc.Vec3(x, y, z));
    });
  });
  const viewCubeScene = root.querySelector<HTMLElement>('.view-cube-scene')!;
  let cubeDragging = false;
  let cubeDragMoved = false;
  let cubeDragDistance = 0;
  let cubeDragAxis: 'horizontal' | 'vertical' | 'free' | null = null;
  let cubeStartX = 0;
  let cubeStartY = 0;
  let cubeLastX = 0;
  let cubeLastY = 0;
  viewCubeScene.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cubeDragging = true; cubeDragMoved = false; cubeDragDistance = 0; cubeDragAxis = null;
    cubeStartX = cubeLastX = event.clientX;
    cubeStartY = cubeLastY = event.clientY;
  });
  viewCubeScene.addEventListener('pointermove', event => {
    if (!cubeDragging) return;
    const dx = event.clientX - cubeLastX; const dy = event.clientY - cubeLastY;
    cubeLastX = event.clientX; cubeLastY = event.clientY; cubeDragDistance += Math.hypot(dx, dy);
    if (cubeDragDistance > 5 && !cubeDragMoved) {
      cubeDragMoved = true;
      const totalX = event.clientX - cubeStartX; const totalY = event.clientY - cubeStartY;
      cubeDragAxis = Math.abs(totalY) > Math.abs(totalX) * 1.5
        ? 'vertical' : Math.abs(totalX) > Math.abs(totalY) * 1.5 ? 'horizontal' : 'free';
      viewCubeScene.setPointerCapture(event.pointerId);
      viewCubeScene.classList.add('dragging');
    }
    if (!cubeDragMoved) return;
    orbitCamera((cubeDragAxis === 'vertical' ? 0 : dx) * 0.6, (cubeDragAxis === 'horizontal' ? 0 : dy) * 0.6);
  });
  viewCubeScene.addEventListener('pointerup', event => {
    cubeDragging = false; viewCubeScene.classList.remove('dragging');
    if (viewCubeScene.hasPointerCapture(event.pointerId)) viewCubeScene.releasePointerCapture(event.pointerId);
  });
  viewCubeScene.addEventListener('pointercancel', () => { cubeDragging = false; viewCubeScene.classList.remove('dragging'); });
  viewCubeScene.addEventListener('click', event => {
    if (!cubeDragMoved) return;
    event.preventDefault(); event.stopImmediatePropagation(); cubeDragMoved = false;
  }, { capture: true });
  root.querySelectorAll<HTMLButtonElement>('.projection-switch button').forEach(button => {
    button.addEventListener('click', () => {
      const orthographic = button.dataset.projection === 'orthographic';
      camera.camera!.projection = orthographic ? pc.PROJECTION_ORTHOGRAPHIC : pc.PROJECTION_PERSPECTIVE;
      camera.camera!.orthoHeight = cameraOrthoHeight;
      root.querySelectorAll('.projection-switch button').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
    });
  });

  let navigation: 'orbit' | 'pan' | null = null; let lastX = 0; let lastY = 0;
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointermove', event => {
    if (clippingHandles?.pointerMove(event)) {
      canvas.style.cursor = clippingHandles.dragging ? 'grabbing' : 'grab';
      navigation = null;
    } else {
      canvas.style.cursor = '';
    }
  }, { capture: true });
  canvas.addEventListener('pointerleave', () => clippingHandles?.pointerLeave());
  canvas.addEventListener('pointerdown', event => {
    if (clippingHandles?.pointerDown(event)) { event.preventDefault(); event.stopImmediatePropagation(); navigation = null; return; }
    const clipGizmoHovered = clipTranslateHovered || clipRotateHovered;
    const gizmoHovered = clippingInteractionActive ? clipGizmoHovered : (translateGizmoHovered || rotateGizmoHovered);
    if (event.button === 2 || gizmoTransforming || (event.button === 0 && gizmoHovered)) return;
    if (event.button === 0) navigation = 'orbit'; else if (event.button === 1) navigation = 'pan'; else return;
    lastX = event.clientX; lastY = event.clientY;
  }, { capture: true });
  window.addEventListener('pointerup', event => { clippingHandles?.pointerUp(event); navigation = null; canvas.style.cursor = ''; });
  window.addEventListener('pointermove', event => {
    if (!navigation || gizmoTransforming) return; const dx = event.clientX - lastX; const dy = event.clientY - lastY; lastX = event.clientX; lastY = event.clientY;
    if (navigation === 'orbit') orbitCamera(dx * 180 / Math.max(1, canvas.clientWidth), dy * 180 / Math.max(1, canvas.clientHeight));
    else {
      const worldPerPixel = camera.camera!.projection === pc.PROJECTION_ORTHOGRAPHIC
        ? cameraOrthoHeight * 2 / Math.max(canvas.clientHeight, 1)
        : 2 * cameraDistance * Math.tan(camera.camera!.fov * Math.PI / 360) / Math.max(canvas.clientHeight, 1);
      const right = new pc.Vec3().cross(cameraUp, cameraDirection).normalize();
      cameraTarget.add(right.mulScalar(-dx * worldPerPixel)).add(cameraUp.clone().mulScalar(dy * worldPerPixel));
      updateCamera();
    }
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (camera.camera!.projection === pc.PROJECTION_ORTHOGRAPHIC) {
      cameraOrthoHeight = Math.max(bounds.diagonal * 0.001, cameraOrthoHeight * Math.exp(event.deltaY * 0.001));
      camera.camera!.orthoHeight = cameraOrthoHeight;
    } else {
      cameraDistance = Math.max(bounds.diagonal * 0.001, cameraDistance * Math.exp(event.deltaY * 0.001));
      updateCamera();
    }
  }, { passive: false });

  let finalText = '';
  let inverseText = '';
  const copyMatrix = async (button: HTMLButtonElement, text: string, defaultLabel: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
    } catch {
      button.textContent = '复制失败';
    }
    window.setTimeout(() => { button.textContent = defaultLabel; }, 1500);
  };
  const copyResultButton = root.querySelector<HTMLButtonElement>('#copy-result')!;
  const copyInverseButton = root.querySelector<HTMLButtonElement>('#copy-inverse')!;
  copyResultButton.addEventListener('click', () => copyMatrix(copyResultButton, finalText, '复制最终业务矩阵'));
  copyInverseButton.addEventListener('click', () => copyMatrix(copyInverseButton, inverseText, '复制反向矩阵'));
  const registerButton = root.querySelector<HTMLButtonElement>('#register')!;
  const cancelButton = root.querySelector<HTMLButtonElement>('#cancel-registration')!;
  const progressCheckbox = root.querySelector<HTMLInputElement>('#show-registration-progress')!;
  const iterationProgress = root.querySelector<HTMLElement>('#iteration-progress')!;
  const registrationControls = [outputDirection, movingSelect, resetButton,
    ...Object.values(inputs),
    root.querySelector<HTMLInputElement>('#min-rms')!, root.querySelector<HTMLInputElement>('#sampling-limit')!,
    root.querySelector<HTMLInputElement>('#overlap')!, root.querySelector<HTMLInputElement>('#random-seed')!];
  let activeJobId = '';
  let activeProgressUrl = '';
  let cancelRequested = false;
  let progressSource: EventSource | null = null;
  let lastProgressMatrix: Matrix4 | null = null;
  let latestProgressIteration = 0;
  const stopProgressDisplay = () => {
    progressSource?.close();
    progressSource = null;
  };
  const startProgressDisplay = () => {
    if (!activeProgressUrl || progressSource) return;
    iterationProgress.hidden = false;
    iterationProgress.textContent = latestProgressIteration > 0
      ? iterationProgress.textContent : '正在读取当前 ICP 进度……';
    progressSource = new EventSource(`${activeProgressUrl}?from_latest=true`);
    progressSource.addEventListener('iteration', event => {
      const progress = JSON.parse((event as MessageEvent<string>).data) as IterationEvent;
      if (progress.iteration <= latestProgressIteration) return;
      latestProgressIteration = progress.iteration;
      lastProgressMatrix = progress.moving_local_to_fixed_local;
      applyMatrix(movingEntity(), lastProgressMatrix);
      iterationProgress.textContent = `第 ${progress.iteration} 轮　RMS ${progress.rms.toFixed(6)} m　${progress.point_count.toLocaleString()} 点　${progress.elapsed_seconds.toFixed(2)} s`;
    });
    progressSource.addEventListener('terminal', stopProgressDisplay);
  };
  progressCheckbox.addEventListener('change', () => {
    if (progressCheckbox.checked) {
      iterationProgress.hidden = false;
      if (running) startProgressDisplay();
    } else {
      stopProgressDisplay();
      iterationProgress.hidden = true;
    }
  });
  const setRunning = (value: boolean) => {
    running = value;
    registerButton.disabled = value;
    registerButton.classList.toggle('running', value);
    registerButton.textContent = value ? 'ICP 配准中' : '执行 ICP 精配准';
    cancelButton.hidden = !value;
    cancelButton.disabled = false;
    cancelButton.textContent = '终止任务';
    registrationControls.forEach(control => { control.disabled = value; });
    attach();
  };
  cancelButton.addEventListener('click', async () => {
    cancelRequested = true;
    cancelButton.disabled = true;
    cancelButton.textContent = '正在终止…';
    if (!activeJobId) return;
    try {
      const response = await fetch(`/api/v1/registrations/${activeJobId}/cancel`, { method: 'POST' });
      if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      root.querySelector<HTMLElement>('#job-status')!.textContent = `终止失败：${String(error)}`;
      cancelRequested = false;
      cancelButton.disabled = false;
      cancelButton.textContent = '终止任务';
    }
  });
  registerButton.addEventListener('click', async () => {
    const log = root.querySelector<HTMLElement>('#job-status')!;
    activeJobId = ''; activeProgressUrl = ''; cancelRequested = false; lastProgressMatrix = null; latestProgressIteration = 0;
    iterationProgress.hidden = !progressCheckbox.checked;
    iterationProgress.textContent = progressCheckbox.checked ? '等待首轮 ICP 结果……' : '';
    setRunning(true); log.textContent = '正在提交……';
    try {
      const response = await fetch(`/api/v2/registration-sessions/${sessionId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          initial_moving_local_to_fixed_local: entityMatrix(movingEntity()), output_direction: outputDirection.value,
          moving_model: movingSelect.value, min_rms_decrease: Number((root.querySelector('#min-rms') as HTMLInputElement).value),
          sampling_limit: Number((root.querySelector('#sampling-limit') as HTMLInputElement).value), overlap: Number((root.querySelector('#overlap') as HTMLInputElement).value),
          random_seed: Number((root.querySelector('#random-seed') as HTMLInputElement).value),
          show_registration_progress: true,
        }),
      });
      const created = await response.json(); if (!response.ok) throw new Error(created.detail ?? `HTTP ${response.status}`);
      activeJobId = created.job_id;
      activeProgressUrl = created.progress_url;
      if (progressCheckbox.checked) startProgressDisplay();
      if (cancelRequested) await fetch(`/api/v1/registrations/${activeJobId}/cancel`, { method: 'POST' });
      while (true) {
        const status = await fetch(created.status_url).then(value => value.json()); log.textContent = `任务状态：${status.status}`;
        if (status.status === 'cancelled') {
          if (lastProgressMatrix) applyMatrix(movingEntity(), lastProgressMatrix);
          log.textContent = lastProgressMatrix
            ? '任务已终止。视口停留在未收敛的中间姿态，该姿态不是有效业务矩阵，可继续粗调后重新执行。'
            : '任务已终止，可调整参数或粗配准后重新执行。';
          break;
        }
        if (status.status === 'failed') throw new Error(status.error ?? 'ICP 失败');
        if (status.status === 'succeeded') {
          const result = await fetch(status.result_url).then(value => value.json()) as RegistrationResult;
          progressSource?.close(); progressSource = null;
          applyMatrix(movingEntity(), result.moving_local_to_fixed_local);
          const matrix = result.recommended_matrix.value; finalText = matrixText(matrix);
          root.querySelector<HTMLElement>('#result')!.hidden = false;
          root.querySelector<HTMLElement>('#result-title')!.textContent = `最终业务矩阵：${result.recommended_matrix.name}`;
          root.querySelector<HTMLElement>('#result-formula')!.textContent = result.recommended_matrix.formula;
          root.querySelector<HTMLElement>('#result-matrix')!.textContent = finalText;
          inverseText = matrixText(outputDirection.value === 'a_to_b' ? result.b_to_a : result.a_to_b);
          root.querySelector<HTMLElement>('#inverse-matrix')!.textContent = inverseText;
          root.querySelector<HTMLElement>('#result-metrics')!.textContent = `RMS：${result.metrics.final_rms.toFixed(6)} m　点数：${result.metrics.final_point_count}　耗时：${result.metrics.elapsed_seconds.toFixed(2)} s`;
          break;
        }
        await sleep(1000);
      }
    } catch (error) { log.textContent = `失败：${String(error)}`; }
    finally { stopProgressDisplay(); activeJobId = ''; activeProgressUrl = ''; cancelRequested = false; setRunning(false); }
  });
}
