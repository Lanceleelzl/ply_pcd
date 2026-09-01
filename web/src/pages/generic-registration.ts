import * as pc from 'playcanvas';
import { createPointCloudEntity, loadPreview, type PreviewCloud } from '../point-cloud';
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
        <section class="workflow-step completed"><h2><span>1</span> 模型</h2><p>A：${infoA.source_point_count.toLocaleString()} 点<br>B：${infoB.source_point_count.toLocaleString()} 点</p><p id="badge" class="model-role-summary"></p></section>
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
      <section class="viewport"><canvas id="viewport"></canvas><div class="viewport-toolbar toolbar"><strong>粗配准</strong><button id="translate" class="active">平移 G</button><button id="rotate">旋转 R</button><button id="reset" title="清除当前移动模型的平移和旋转，恢复到模型刚加载时的位置">重置粗配准</button><button id="fit">适应全部</button><div class="model-visibility" aria-label="模型显示控制"><button id="toggle-model-a" class="active">A：显示</button><button id="toggle-model-b" class="active">B：显示</button></div></div><div id="iteration-progress" class="viewport-progress" hidden></div>
        <div class="view-gizmo" aria-label="快速视角"><div class="view-cube-scene"><div class="view-cube"><button class="cube-face face-x" data-direction="1,0,0" title="沿 +X 查看">X</button><button class="cube-face face-nx" data-direction="-1,0,0" title="沿 -X 查看">−X</button><button class="cube-face face-y" data-direction="0,1,0" title="沿 +Y 查看">Y</button><button class="cube-face face-ny" data-direction="0,-1,0" title="沿 -Y 查看">−Y</button><button class="cube-face face-z" data-direction="0,0,1" title="顶视图（沿 +Z 查看）">Z</button><button class="cube-face face-nz" data-direction="0,0,-1" title="底视图（沿 -Z 查看）">−Z</button>${[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => `<button class="cube-corner" data-direction="${x},${y},${z}" style="--cx:${x};--cy:${y};--cz:${z}" title="等轴视角 ${x > 0 ? '+' : '−'}X ${y > 0 ? '+' : '−'}Y ${z > 0 ? '+' : '−'}Z"></button>`))).join('')}</div></div><div class="projection-switch"><button data-projection="orthographic">正交</button><button data-projection="perspective" class="active">透视</button></div></div>
        <div class="viewport-help">左键空白：旋转　中键：平移　滚轮：缩放　左键手柄：调整黄色移动模型</div></section>
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
  const camera = new pc.Entity('Camera');
  camera.addComponent('camera', { clearColor: new pc.Color(0.035, 0.055, 0.085), farClip: 100000 });
  application.root.addChild(camera);
  const entityA = createPointCloudEntity(application, cloudA, new pc.Color(0.68, 0.72, 0.78), 'Model A');
  const entityB = createPointCloudEntity(application, cloudB, new pc.Color(0.68, 0.72, 0.78), 'Model B');
  application.root.addChild(entityA); application.root.addChild(entityB);
  const entities = { a: entityA, b: entityB };
  const modelVisible: Record<ModelId, boolean> = { a: true, b: true };
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

  const layer = pc.TranslateGizmo.createLayer(application, 'Moving Model Transform');
  const translate = new pc.TranslateGizmo(camera.camera!, layer);
  const rotate = new pc.RotateGizmo(camera.camera!, layer);
  translate.mouseButtons[1] = translate.mouseButtons[2] = false;
  rotate.mouseButtons[1] = rotate.mouseButtons[2] = false;
  let mode: 'translate' | 'rotate' = 'translate';
  let running = false;
  let gizmoTransforming = false;
  let translateGizmoHovered = false;
  let rotateGizmoHovered = false;
  const onTransformStart = () => { gizmoTransforming = true; navigation = null; };
  const onTransformEnd = () => { gizmoTransforming = false; };
  translate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, onTransformStart);
  translate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, onTransformEnd);
  rotate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, onTransformStart);
  rotate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, onTransformEnd);
  translate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => { translateGizmoHovered = Boolean(meshInstance); });
  rotate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => { rotateGizmoHovered = Boolean(meshInstance); });
  const movingEntity = () => entities[effectiveMoving()];
  const fixedEntity = () => entities[effectiveMoving() === 'a' ? 'b' : 'a'];
  const attach = () => {
    translate.detach(); rotate.detach();
    if (!running && modelVisible[effectiveMoving()]) (mode === 'translate' ? translate : rotate).attach(movingEntity());
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
      const material = instance.material as pc.StandardMaterial;
      material.diffuse = color; material.emissive = color; material.update();
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

  application.on('update', () => {
    const position = movingEntity().getLocalPosition(); const rotation = movingEntity().getLocalEulerAngles();
    const values = [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z];
    ['px', 'py', 'pz', 'rx', 'ry', 'rz'].forEach((key, index) => { if (document.activeElement !== inputs[key]) inputs[key].value = values[index].toFixed(3); });
    root.querySelector<HTMLElement>('#initial-matrix')!.textContent = matrixText(entityMatrix(movingEntity()));
  });

  const translateButton = root.querySelector<HTMLButtonElement>('#translate')!;
  const rotateButton = root.querySelector<HTMLButtonElement>('#rotate')!;
  const resetButton = root.querySelector<HTMLButtonElement>('#reset')!;
  const setMode = (nextMode: 'translate' | 'rotate') => {
    if (running) return;
    mode = nextMode;
    translateButton.classList.toggle('active', mode === 'translate');
    rotateButton.classList.toggle('active', mode === 'rotate');
    attach();
  };
  translateButton.addEventListener('click', () => setMode('translate'));
  rotateButton.addEventListener('click', () => setMode('rotate'));
  resetButton.addEventListener('click', () => { if (!running) applyMatrix(movingEntity(), identity()); });
  root.querySelector('#fit')!.addEventListener('click', fitCamera);
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
  canvas.addEventListener('pointerdown', event => {
    const gizmoHovered = mode === 'translate' ? translateGizmoHovered : rotateGizmoHovered;
    if (event.button === 2 || gizmoTransforming || (event.button === 0 && gizmoHovered)) return;
    if (event.button === 0) navigation = 'orbit'; else if (event.button === 1) navigation = 'pan'; else return;
    lastX = event.clientX; lastY = event.clientY;
  });
  window.addEventListener('pointerup', () => { navigation = null; });
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
  const registrationControls = [outputDirection, movingSelect, translateButton, rotateButton, resetButton,
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
