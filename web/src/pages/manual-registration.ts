import * as pc from 'playcanvas';
import { createPointCloudEntity, loadPreview, type PreviewCloud } from '../point-cloud';
import '../view-gizmo.css';
import '../workspace.css';

type Matrix4 = number[][];

interface SessionStatus {
  status: string;
  error?: string;
  inputs?: { ply_bytes: number; pcd_bytes: number };
  ply_preview_url?: string;
  pcd_preview_url?: string;
  gaussian_preview_url?: string;
  metadata?: {
    clouds: {
      ply: { preview_point_count: number };
      pcd: { preview_point_count: number };
    };
  };
  registrations?: Array<{
    job_id: string;
    status: string;
    result_url?: string;
    initial_pcd_to_ply: Matrix4;
    precision_mode: string;
    parameters: {
      min_rms_decrease: number;
      sampling_limit: number;
      overlap: number;
      random_seed: number;
    };
  }>;
}

interface RegistrationResult {
  recommended_matrix: { value: Matrix4 };
  pcd_to_ply?: Matrix4;
  metrics: { final_rms: number; final_point_count: number; elapsed_seconds: number };
  precision?: {
    mode: string;
    translation_stability_m: number;
    rotation_stability_deg: number;
    stable: boolean;
  };
}

interface RegistrationRound {
  number: number;
  jobId: string;
  mode: string;
  parameters: { minRmsDecrease: number; samplingLimit: number; overlap: number; randomSeed: number };
  initialPcdToPly: Matrix4;
  result: RegistrationResult;
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function waitForSession(sessionId: string, statusElement: HTMLElement): Promise<SessionStatus> {
  while (true) {
    const response = await fetch(`/api/v1/manual-registration-sessions/${sessionId}`);
    const status = await response.json() as SessionStatus;
    statusElement.textContent = `预览状态：${status.status}`;
    if (status.status === 'ready') return status;
    if (status.status === 'failed') throw new Error(status.error ?? '预览生成失败');
    await sleep(1000);
  }
}

function entityMatrix(entity: pc.Entity): Matrix4 {
  const data = entity.getWorldTransform().data;
  return Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => Number(data[column * 4 + row]))
  );
}

function matrixText(matrix: Matrix4): string {
  return matrix.map(row => row.map(value => value.toFixed(9)).join(' ')).join('\n');
}

function combinedBounds(ply: PreviewCloud, pcd: PreviewCloud): { center: pc.Vec3; diagonal: number } {
  const min = new pc.Vec3(
    Math.min(ply.min.x, pcd.min.x), Math.min(ply.min.y, pcd.min.y), Math.min(ply.min.z, pcd.min.z)
  );
  const max = new pc.Vec3(
    Math.max(ply.max.x, pcd.max.x), Math.max(ply.max.y, pcd.max.y), Math.max(ply.max.z, pcd.max.z)
  );
  return { center: min.clone().add(max).mulScalar(0.5), diagonal: max.clone().sub(min).length() };
}

export async function renderManualRegistration(root: HTMLElement, sessionId: string): Promise<void> {
  root.innerHTML = `<main class="editor integrated-editor"><div class="workspace integrated-workspace"><aside class="panel workflow-panel"><div class="workflow-title"><div><h1>PLY／PCD 配准工作台</h1><small>正在准备三维场景</small></div></div><section class="workflow-step completed"><h2><span>1</span> 文件上传完成</h2></section><section class="workflow-step"><h2><span>2</span> 生成轻量预览</h2><pre id="loading-status" class="status timeline">预览状态：queued</pre></section><section class="workflow-step"><h2><span>3</span> 加载三维场景</h2><p class="step-hint">预览完成后自动加载，无需重复上传。</p></section></aside><section class="viewport preview-loading"><div><h2>正在准备点云预览</h2><p>大文件只在服务器端处理，浏览器加载轻量数据。</p></div></section></div></main>`;
  const session = await waitForSession(sessionId, root.querySelector('#loading-status')!);
  const [plyCloud, pcdCloud] = await Promise.all([
    loadPreview(session.ply_preview_url!), loadPreview(session.pcd_preview_url!)
  ]);
  const gaussianButtonLabel = session.inputs?.ply_bytes
    ? `完整 Gaussian（${formatBytes(session.inputs.ply_bytes)}）`
    : '完整 Gaussian';

  root.innerHTML = `
    <main class="editor integrated-editor">
      <div class="workspace integrated-workspace">
        <aside class="panel workflow-panel">
          <div class="workflow-title"><div><h1>PLY／PCD 配准工作台</h1><small>PLY 固定，PCD 可调整</small></div><button id="new-task">新建</button></div>
          <section class="workflow-step completed"><h2><span>1</span> 数据与预览</h2><p>PLY ${plyCloud.count.toLocaleString()} 点<br>PCD ${pcdCloud.count.toLocaleString()} 点</p></section>
          <section class="workflow-step"><h2><span>2</span> 人工粗配准（可选）</h2><p class="step-hint">在视口浮动工具栏选择平移或旋转，只调整黄色 PCD。</p>
            <h3>平移／m</h3><div class="field-grid" id="position"></div>
            <h3>旋转／°</h3><div class="field-grid" id="rotation"></div>
            <details><summary>查看 T_manual_pcd_to_ply</summary><pre id="matrix" class="matrix"></pre></details>
          </section>
          <section class="workflow-step"><h2><span>3</span> ICP 精配准</h2>
            <label class="parameter-label">精度模式<select id="parameter-mode"><option value="recommended">推荐模式（CloudCompare 默认参数基线）</option><option value="high_accuracy">高采样稳定性模式（三次重复性验证）</option><option value="custom">自定义单阶段参数</option></select></label>
            <p id="precision-hint" class="step-hint">采用 CloudCompare 默认采样上限 50,000；本项目使用固定种子复现验证，并非用户手工设置。</p>
            <div class="icp-grid">
              <label>RMS 阈值<input id="min-rms" type="number" value="0.00001" step="0.000001"></label>
              <label><span id="sampling-limit-label">采样上限</span><input id="sampling-limit" type="number" value="50000" step="1000"></label>
              <label>重叠率<input id="overlap" type="number" value="1" min="0.01" max="1" step="0.01"></label>
              <label>随机种子<input id="random-seed" type="number" value="42" min="0" step="1"></label>
            </div>
            <div id="high-accuracy-parameters" class="mode-parameters" hidden>
              <strong>第二阶段实际参数</strong>
              <div class="icp-grid">
                <label>采样上限<input type="text" value="500000" disabled></label>
                <label>当前 PCD 输入点<input type="text" value="${Math.min(pcdCloud.count, 500000)}${pcdCloud.count <= 500000 ? '（未截断）' : '（已截断）'}" disabled></label>
                <label>重复运行<input type="text" value="3 次" disabled></label>
                <label>随机种子<input type="text" value="42／43／44" disabled></label>
                <label>稳定性判据<input type="text" value="≤0.02 m／≤0.2°" disabled></label>
              </div>
            </div>
            <button id="register" class="primary full-width">直接执行 ICP 精配准</button>
          </section>
          <section class="workflow-step"><h2><span>4</span> 任务与结果</h2><pre id="job-status" class="status timeline">尚未提交</pre>
            <section id="result" class="result" hidden><h3>当前已完成业务矩阵：PLY→PCD</h3><p class="result-formula">p_pcd = T_ply_to_pcd × p_ply</p><p id="result-stale" class="result-warning" hidden>当前 PCD 姿态或参数已改变。下方仍是上一次已完成矩阵，请重新执行 ICP 后再用于航点转换。</p><pre id="result-matrix" class="matrix"></pre><div id="result-metrics"></div><button id="copy-final-matrix" class="full-width" type="button">复制最终 PLY→PCD 矩阵</button></section>
            <div id="result-history" class="result-history"></div>
          </section>
        </aside>
        <section class="viewport"><canvas id="viewport"></canvas>
          <div class="viewport-toolbar toolbar"><strong>粗配准工具</strong><button id="translate" class="active">平移 G</button><button id="rotate">旋转 R</button><button id="reset">重置 PCD</button><button id="fit">适应全部</button><button id="gaussian" ${session.gaussian_preview_url ? '' : 'class="disabled" disabled'}>${gaussianButtonLabel}</button></div>
          <div class="badge">PLY ${plyCloud.count.toLocaleString()} 点　PCD ${pcdCloud.count.toLocaleString()} 点</div>
          <div class="view-gizmo" aria-label="快速视角"><div class="view-cube-scene"><div class="view-cube"><button class="cube-face face-x" data-direction="1,0,0" title="沿 +X 查看">X</button><button class="cube-face face-nx" data-direction="-1,0,0" title="沿 -X 查看">−X</button><button class="cube-face face-y" data-direction="0,1,0" title="沿 +Y 查看">Y</button><button class="cube-face face-ny" data-direction="0,-1,0" title="沿 -Y 查看">−Y</button><button class="cube-face face-z" data-direction="0,0,1" title="顶视图（沿 +Z 查看）">Z</button><button class="cube-face face-nz" data-direction="0,0,-1" title="底视图（沿 -Z 查看）">−Z</button>${[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => `<button class="cube-corner" data-direction="${x},${y},${z}" style="--cx:${x};--cy:${y};--cz:${z}" title="等轴视角 ${x > 0 ? '+' : '−'}X ${y > 0 ? '+' : '−'}Y ${z > 0 ? '+' : '−'}Z"></button>`))).join('')}</div></div><div class="projection-switch"><button data-projection="orthographic">正交</button><button data-projection="perspective" class="active">透视</button></div></div>
          <div class="viewport-help">左键空白处：旋转　中键：平移　滚轮：缩放　左键手柄：变换 PCD　右键：未绑定</div>
        </section>
      </div>
    </main>`;

  root.querySelectorAll<HTMLElement>('.cube-face').forEach(face => { face.style.backfaceVisibility = 'hidden'; });

  const canvas = root.querySelector<HTMLCanvasElement>('#viewport')!;
  const mouse = new pc.Mouse(canvas);
  const touch = new pc.TouchDevice(canvas);
  const keyboard = new pc.Keyboard(window);
  const application = new pc.Application(canvas, { mouse, touch, keyboard });
  application.setCanvasResolution(pc.RESOLUTION_AUTO);
  application.start();
  application.scene.gsplat.alphaClip = 0.1;
  const viewport = root.querySelector<HTMLElement>('.viewport')!;
  const resizeViewport = () => {
    application.graphicsDevice.resizeCanvas(viewport.clientWidth, viewport.clientHeight);
  };
  requestAnimationFrame(resizeViewport);
  window.addEventListener('resize', resizeViewport);

  const camera = new pc.Entity('Camera');
  camera.addComponent('camera', {
    clearColor: new pc.Color(0.035, 0.055, 0.085),
    farClip: 10000,
    toneMapping: pc.TONEMAP_ACES
  });
  application.root.addChild(camera);
  const plyEntity = createPointCloudEntity(application, plyCloud, new pc.Color(0.68, 0.72, 0.78), 'Fixed PLY');
  const pcdEntity = createPointCloudEntity(application, pcdCloud, new pc.Color(1.0, 0.72, 0.08), 'Movable PCD');
  application.root.addChild(plyEntity);
  application.root.addChild(pcdEntity);
  let gaussianEntity: pc.Entity | null = null;
  let gaussianAsset: pc.Asset | null = null;
  let gaussianVisible = false;
  const gaussianButton = root.querySelector<HTMLButtonElement>('#gaussian')!;
  gaussianButton.addEventListener('click', async () => {
    if (!session.gaussian_preview_url) return;
    gaussianButton.disabled = true;
    try {
      if (gaussianVisible && gaussianEntity && gaussianAsset) {
        gaussianEntity.destroy();
        gaussianAsset.unload();
        application.assets.remove(gaussianAsset);
        gaussianEntity = null;
        gaussianAsset = null;
        gaussianVisible = false;
        plyEntity.enabled = true;
        gaussianButton.textContent = gaussianButtonLabel;
        gaussianButton.classList.remove('active');
        return;
      }
      gaussianButton.textContent = '完整 Gaussian 加载中…';
      gaussianAsset = new pc.Asset('Original Gaussian PLY', 'gsplat', {
        url: session.gaussian_preview_url,
        filename: 'original-gaussian-model.ply'
      });
      application.assets.add(gaussianAsset);
      await new Promise<void>((resolve, reject) => {
        gaussianAsset!.ready(() => resolve());
        gaussianAsset!.once('error', (error: unknown) => reject(error));
        application.assets.load(gaussianAsset!);
      });
      gaussianEntity = new pc.Entity('Fixed Original Gaussian PLY');
      gaussianEntity.addComponent('gsplat', { asset: gaussianAsset });
      application.root.addChild(gaussianEntity);
      gaussianVisible = true;
      plyEntity.enabled = false;
      gaussianButton.textContent = '释放 Gaussian／显示中心点';
      gaussianButton.classList.add('active');
    } catch (error) {
      if (gaussianAsset) {
        gaussianAsset.unload();
        application.assets.remove(gaussianAsset);
      }
      gaussianAsset = null;
      gaussianEntity = null;
      gaussianVisible = false;
      plyEntity.enabled = true;
      gaussianButton.textContent = 'Gaussian 加载失败';
      console.error(error);
    } finally {
      gaussianButton.disabled = false;
    }
  });

  const bounds = combinedBounds(plyCloud, pcdCloud);
  const cameraTarget = bounds.center.clone();
  let cameraDistance = Math.max(bounds.diagonal * 1.2, 0.1);
  let cameraOrthoHeight = Math.max(bounds.diagonal * 0.6, 0.05);
  let cameraYaw = 135;
  let cameraPitch = 24;
  const zUp = new pc.Vec3(0, 0, 1);
  const cameraDirection = new pc.Vec3();
  const cameraUp = zUp.clone();
  const setDirectionFromAngles = (yawDegrees: number, pitchDegrees: number) => {
    const yaw = yawDegrees * Math.PI / 180;
    const pitch = pitchDegrees * Math.PI / 180;
    const horizontal = Math.cos(pitch);
    cameraDirection.set(horizontal * Math.sin(yaw), horizontal * Math.cos(yaw), Math.sin(pitch)).normalize();
  };
  setDirectionFromAngles(cameraYaw, cameraPitch);
  const viewCube = root.querySelector<HTMLElement>('.view-cube')!;
  const cubeCorners = Array.from(root.querySelectorAll<HTMLElement>('.cube-corner'));
  const updateCamera = () => {
    cameraYaw = Math.atan2(cameraDirection.x, cameraDirection.y) * 180 / Math.PI;
    cameraPitch = Math.asin(Math.max(-1, Math.min(1, cameraDirection.z))) * 180 / Math.PI;
    camera.setPosition(cameraTarget.clone().add(cameraDirection.clone().mulScalar(cameraDistance)));
    camera.lookAt(cameraTarget, cameraUp);
    const cameraRight = new pc.Vec3().cross(cameraUp, cameraDirection).normalize();
    const cubeTransform = `matrix3d(${cameraRight.x},${-cameraUp.x},${cameraDirection.x},0,${cameraRight.y},${-cameraUp.y},${cameraDirection.y},0,${cameraRight.z},${-cameraUp.z},${cameraDirection.z},0,0,0,0,1)`;
    const inverseCubeTransform = `matrix3d(${cameraRight.x},${cameraRight.y},${cameraRight.z},0,${-cameraUp.x},${-cameraUp.y},${-cameraUp.z},0,${cameraDirection.x},${cameraDirection.y},${cameraDirection.z},0,0,0,0,1)`;
    viewCube.style.transform = cubeTransform;
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
    cameraYaw = 135;
    cameraPitch = 24;
    setDirectionFromAngles(cameraYaw, cameraPitch);
    cameraUp.copy(zUp);
    updateCamera();
  };
  fitCamera();

  const gizmoLayer = pc.TranslateGizmo.createLayer(application, 'PCD Transform');
  const translateGizmo = new pc.TranslateGizmo(camera.camera!, gizmoLayer);
  const rotateGizmo = new pc.RotateGizmo(camera.camera!, gizmoLayer);
  translateGizmo.mouseButtons[1] = false;
  translateGizmo.mouseButtons[2] = false;
  rotateGizmo.mouseButtons[1] = false;
  rotateGizmo.mouseButtons[2] = false;

  const inputs: Record<string, HTMLInputElement> = {};
  const createInputs = (containerId: string, prefix: string) => {
    const container = root.querySelector<HTMLElement>(`#${containerId}`)!;
    for (const axis of ['x', 'y', 'z']) {
      const label = document.createElement('label');
      label.textContent = axis.toUpperCase();
      const input = document.createElement('input');
      input.type = 'number'; input.step = prefix === 'p' ? '0.01' : '0.1'; input.value = '0';
      inputs[`${prefix}${axis}`] = input; label.appendChild(input); container.appendChild(label);
    }
  };
  createInputs('position', 'p'); createInputs('rotation', 'r');
  let registrationRunning = false;
  let resultStale = false;
  let lastCompletedRound: RegistrationRound | null = null;
  const registrationRounds: RegistrationRound[] = [];
  const markResultStale = () => {
    if (!lastCompletedRound || registrationRunning) return;
    resultStale = true;
    root.querySelector<HTMLElement>('#result-stale')!.hidden = false;
    root.querySelector<HTMLButtonElement>('#copy-final-matrix')!.textContent = '复制上一次已完成矩阵';
  };
  const applyInputs = () => {
    if (registrationRunning) return;
    pcdEntity.setLocalPosition(Number(inputs.px.value), Number(inputs.py.value), Number(inputs.pz.value));
    pcdEntity.setLocalEulerAngles(Number(inputs.rx.value), Number(inputs.ry.value), Number(inputs.rz.value));
    markResultStale();
  };
  Object.values(inputs).forEach(input => input.addEventListener('input', applyInputs));

  const matrixElement = root.querySelector<HTMLElement>('#matrix')!;
  const registerButton = root.querySelector<HTMLButtonElement>('#register')!;
  const translateButton = root.querySelector<HTMLButtonElement>('#translate')!;
  const rotateButton = root.querySelector<HTMLButtonElement>('#rotate')!;
  const resetButton = root.querySelector<HTMLButtonElement>('#reset')!;
  let activeGizmoMode: 'translate' | 'rotate' = 'translate';
  application.on('update', () => {
    const position = pcdEntity.getLocalPosition();
    const rotation = pcdEntity.getLocalEulerAngles();
    const values = [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z];
    ['px', 'py', 'pz', 'rx', 'ry', 'rz'].forEach((key, index) => {
      if (document.activeElement !== inputs[key]) inputs[key].value = values[index].toFixed(3);
    });
    matrixElement.textContent = matrixText(entityMatrix(pcdEntity));
    if (!registrationRunning) {
      const manuallyAdjusted = position.lengthSq() > 1e-12 || rotation.lengthSq() > 1e-12;
      registerButton.textContent = lastCompletedRound
        ? resultStale ? '使用当前姿态／参数再次执行 ICP' : '以当前结果再次精配准'
        : manuallyAdjusted ? '使用当前粗配准执行 ICP' : '直接执行 ICP 精配准';
    }
  });

  const setMode = (mode: 'translate' | 'rotate') => {
    if (registrationRunning) return;
    activeGizmoMode = mode;
    translateGizmo.detach();
    rotateGizmo.detach();
    if (mode === 'translate') translateGizmo.attach(pcdEntity);
    else rotateGizmo.attach(pcdEntity);
    ['px', 'py', 'pz'].forEach(key => { inputs[key].disabled = mode !== 'translate'; });
    ['rx', 'ry', 'rz'].forEach(key => { inputs[key].disabled = mode !== 'rotate'; });
    translateButton.classList.toggle('active', mode === 'translate');
    rotateButton.classList.toggle('active', mode === 'rotate');
  };
  translateButton.addEventListener('click', () => setMode('translate'));
  rotateButton.addEventListener('click', () => setMode('rotate'));
  keyboard.on(pc.EVENT_KEYDOWN, event => {
    if (event.key === pc.KEY_G) setMode('translate');
    if (event.key === pc.KEY_R) setMode('rotate');
  });
  setMode('translate');
  resetButton.addEventListener('click', () => {
    if (registrationRunning) return;
    pcdEntity.setLocalPosition(0, 0, 0); pcdEntity.setLocalEulerAngles(0, 0, 0);
    markResultStale();
  });
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
    cubeDragging = true;
    cubeDragMoved = false;
    cubeDragDistance = 0;
    cubeDragAxis = null;
    cubeStartX = event.clientX;
    cubeStartY = event.clientY;
    cubeLastX = event.clientX;
    cubeLastY = event.clientY;
  });
  viewCubeScene.addEventListener('pointermove', event => {
    if (!cubeDragging) return;
    const dx = event.clientX - cubeLastX;
    const dy = event.clientY - cubeLastY;
    cubeLastX = event.clientX;
    cubeLastY = event.clientY;
    cubeDragDistance += Math.hypot(dx, dy);
    if (cubeDragDistance > 5 && !cubeDragMoved) {
      cubeDragMoved = true;
      const totalX = event.clientX - cubeStartX;
      const totalY = event.clientY - cubeStartY;
      cubeDragAxis = Math.abs(totalY) > Math.abs(totalX) * 1.5
        ? 'vertical'
        : Math.abs(totalX) > Math.abs(totalY) * 1.5 ? 'horizontal' : 'free';
      viewCubeScene.setPointerCapture(event.pointerId);
      viewCubeScene.classList.add('dragging');
    }
    if (!cubeDragMoved) return;
    orbitCamera(
      (cubeDragAxis === 'vertical' ? 0 : dx) * 0.6,
      (cubeDragAxis === 'horizontal' ? 0 : dy) * 0.6
    );
  });
  viewCubeScene.addEventListener('pointerup', event => {
    cubeDragging = false;
    viewCubeScene.classList.remove('dragging');
    if (viewCubeScene.hasPointerCapture(event.pointerId)) viewCubeScene.releasePointerCapture(event.pointerId);
  });
  viewCubeScene.addEventListener('pointercancel', () => {
    cubeDragging = false;
    viewCubeScene.classList.remove('dragging');
  });
  viewCubeScene.addEventListener('click', event => {
    if (!cubeDragMoved) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cubeDragMoved = false;
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

  const parameterMode = root.querySelector<HTMLSelectElement>('#parameter-mode')!;
  const parameterInputs = [
    root.querySelector<HTMLInputElement>('#min-rms')!, root.querySelector<HTMLInputElement>('#sampling-limit')!,
    root.querySelector<HTMLInputElement>('#overlap')!, root.querySelector<HTMLInputElement>('#random-seed')!
  ];
  const precisionHint = root.querySelector<HTMLElement>('#precision-hint')!;
  const highAccuracyParameters = root.querySelector<HTMLElement>('#high-accuracy-parameters')!;
  const samplingLimitLabel = root.querySelector<HTMLElement>('#sampling-limit-label')!;
  const recommendedValues = ['0.00001', '50000', '1', '42'];
  const updateParameterMode = () => {
    const custom = parameterMode.value === 'custom';
    const highAccuracy = parameterMode.value === 'high_accuracy';
    if (!custom) parameterInputs.forEach((input, index) => { input.value = recommendedValues[index]; });
    parameterInputs.forEach(input => { input.disabled = !custom; });
    highAccuracyParameters.hidden = !highAccuracy;
    samplingLimitLabel.textContent = highAccuracy ? '第一阶段采样上限' : '采样上限';
    precisionHint.textContent = highAccuracy
      ? '提高采样上限可降低随机子集带来的统计波动；三个种子只验证结果重复性，不代表绝对精度。第二阶段耗时明显增加。'
      : custom
        ? '自定义参数属于单阶段实验模式，修改后必须重新进行 CloudCompare 或控制点验证。'
        : '采用 CloudCompare 默认采样上限 50,000；本项目使用固定种子复现验证，并非用户手工设置。';
  };
  parameterMode.addEventListener('change', () => { updateParameterMode(); markResultStale(); });
  updateParameterMode();
  parameterInputs.forEach(input => input.addEventListener('input', markResultStale));

  const jobStatus = root.querySelector<HTMLElement>('#job-status')!;
  const copyFinalMatrixButton = root.querySelector<HTMLButtonElement>('#copy-final-matrix')!;
  let finalMatrixText = '';
  const copyText = async (value: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  };
  copyFinalMatrixButton.addEventListener('click', async () => {
    if (!finalMatrixText) return;
    try {
      await copyText(finalMatrixText);
      copyFinalMatrixButton.textContent = '已复制 PLY→PCD 矩阵';
      window.setTimeout(() => { copyFinalMatrixButton.textContent = '复制最终 PLY→PCD 矩阵'; }, 1800);
    } catch {
      copyFinalMatrixButton.textContent = '复制失败，请手动复制';
    }
  });
  const timeText = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const logLines: string[] = [];
  const appendLog = (message: string) => {
    logLines.push(`${timeText()}　${message}`);
    jobStatus.textContent = logLines.join('\n');
    jobStatus.scrollTop = jobStatus.scrollHeight;
  };
  const applyPcdToPly = (matrix: Matrix4) => {
    const transform = new pc.Mat4();
    transform.set(Array.from({ length: 16 }, (_, index) => matrix[index % 4][Math.floor(index / 4)]));
    pcdEntity.setLocalPosition(transform.getTranslation());
    pcdEntity.setLocalEulerAngles(transform.getEulerAngles());
  };
  const setRegistrationRunning = (running: boolean) => {
    registrationRunning = running;
    registerButton.disabled = running;
    parameterMode.disabled = running;
    translateButton.disabled = running;
    rotateButton.disabled = running;
    resetButton.disabled = running;
    if (running) {
      translateGizmo.detach();
      rotateGizmo.detach();
      Object.values(inputs).forEach(input => { input.disabled = true; });
      parameterInputs.forEach(input => { input.disabled = true; });
      registerButton.textContent = 'ICP 精配准执行中…';
    } else {
      updateParameterMode();
      setMode(activeGizmoMode);
    }
  };
  const showActiveRound = (round: RegistrationRound) => {
    lastCompletedRound = round;
    root.querySelector<HTMLElement>('#result')!.hidden = false;
    finalMatrixText = matrixText(round.result.recommended_matrix.value);
    root.querySelector<HTMLElement>('#result-matrix')!.textContent = finalMatrixText;
    const rms = Number(round.result.metrics.final_rms);
    const metrics = root.querySelector<HTMLElement>('#result-metrics')!;
    metrics.textContent = `RMS：${rms.toFixed(6)} m／${(rms * 100).toFixed(3)} cm　点数：${round.result.metrics.final_point_count}　耗时：${Number(round.result.metrics.elapsed_seconds).toFixed(2)} s`;
    if (round.result.precision?.mode === 'high_accuracy') {
      const stability = round.result.precision;
      metrics.textContent += `\n重复性：平移 ${Number(stability.translation_stability_m).toFixed(4)} m／旋转 ${Number(stability.rotation_stability_deg).toFixed(4)}°　${stability.stable ? '通过（仍需控制点验证）' : '未通过'}`;
    }
    resultStale = false;
    root.querySelector<HTMLElement>('#result-stale')!.hidden = true;
    copyFinalMatrixButton.textContent = '复制最终 PLY→PCD 矩阵';
  };
  const renderRound = (round: RegistrationRound) => {
    const history = root.querySelector<HTMLElement>('#result-history')!;
    const card = document.createElement('article');
    card.className = 'result-history-card';
    const rms = Number(round.result.metrics.final_rms);
    card.innerHTML = `<h4>第 ${round.number} 轮　${round.mode === 'high_accuracy' ? '高采样稳定性模式' : round.mode === 'custom' ? '自定义模式' : '推荐模式'}</h4>
      <p>RMS：${rms.toFixed(6)} m　点数：${round.result.metrics.final_point_count}　耗时：${Number(round.result.metrics.elapsed_seconds).toFixed(2)} s</p>
      <p>参数：${round.parameters.minRmsDecrease}／${round.parameters.samplingLimit}／${round.parameters.overlap}／种子 ${round.parameters.randomSeed}</p>
      <details><summary>查看本轮初始 PCD→PLY</summary><pre class="matrix">${matrixText(round.initialPcdToPly)}</pre></details>
      <details><summary>查看本轮最终 PLY→PCD</summary><pre class="matrix">${matrixText(round.result.recommended_matrix.value)}</pre></details>
      <div class="history-actions"><button type="button" data-action="restore">恢复本轮结果到视口</button><button type="button" data-action="copy">复制本轮 PLY→PCD</button></div>`;
    card.querySelector<HTMLButtonElement>('[data-action="restore"]')!.addEventListener('click', () => {
      if (registrationRunning || !round.result.pcd_to_ply) return;
      applyPcdToPly(round.result.pcd_to_ply);
      parameterMode.value = round.mode;
      updateParameterMode();
      parameterInputs[0].value = String(round.parameters.minRmsDecrease);
      parameterInputs[1].value = String(round.parameters.samplingLimit);
      parameterInputs[2].value = String(round.parameters.overlap);
      parameterInputs[3].value = String(round.parameters.randomSeed);
      showActiveRound(round);
      appendLog(`已将第 ${round.number} 轮结果恢复到视口`);
    });
    card.querySelector<HTMLButtonElement>('[data-action="copy"]')!.addEventListener('click', async event => {
      const button = event.currentTarget as HTMLButtonElement;
      try {
        await copyText(matrixText(round.result.recommended_matrix.value));
        button.textContent = '已复制';
        window.setTimeout(() => { button.textContent = '复制本轮 PLY→PCD'; }, 1800);
      } catch { button.textContent = '复制失败'; }
    });
    history.prepend(card);
  };
  const restoreSessionHistory = async () => {
    const completed = (session.registrations ?? []).filter(item => item.status === 'succeeded' && item.result_url);
    for (const entry of completed) {
      const result = await fetch(entry.result_url!).then(response => response.json()) as RegistrationResult;
      const restoredMode = entry.precision_mode === 'high_accuracy'
        ? 'high_accuracy'
        : entry.parameters.min_rms_decrease === 0.00001
          && entry.parameters.sampling_limit === 50000
          && entry.parameters.overlap === 1
          && entry.parameters.random_seed === 42 ? 'recommended' : 'custom';
      const round: RegistrationRound = {
        number: registrationRounds.length + 1,
        jobId: entry.job_id,
        mode: restoredMode,
        parameters: {
          minRmsDecrease: entry.parameters.min_rms_decrease,
          samplingLimit: entry.parameters.sampling_limit,
          overlap: entry.parameters.overlap,
          randomSeed: entry.parameters.random_seed
        },
        initialPcdToPly: entry.initial_pcd_to_ply,
        result
      };
      registrationRounds.push(round);
      renderRound(round);
    }
    const latest = registrationRounds.at(-1);
    if (latest?.result.pcd_to_ply) {
      applyPcdToPly(latest.result.pcd_to_ply);
      showActiveRound(latest);
      appendLog(`已恢复 ${registrationRounds.length} 轮历史结果`);
    }
  };
  await restoreSessionHistory();
  registerButton.addEventListener('click', async () => {
    const initialPcdToPly = entityMatrix(pcdEntity);
    const selectedMode = parameterMode.value;
    const parameters = {
      minRmsDecrease: Number(parameterInputs[0].value), samplingLimit: Number(parameterInputs[1].value),
      overlap: Number(parameterInputs[2].value), randomSeed: Number(parameterInputs[3].value)
    };
    setRegistrationRunning(true);
    appendLog('正在提交当前 PCD→PLY 初始矩阵');
    try {
      const response = await fetch(`/api/v1/manual-registration-sessions/${sessionId}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initial_pcd_to_ply: initialPcdToPly,
          precision_mode: selectedMode === 'high_accuracy' ? 'high_accuracy' : 'recommended',
          min_rms_decrease: parameters.minRmsDecrease,
          sampling_limit: parameters.samplingLimit,
          overlap: parameters.overlap,
          random_seed: parameters.randomSeed
        })
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created.detail ?? `HTTP ${response.status}`);
      appendLog(`ICP 任务已创建：${created.job_id}`);
      let previousStatus = '';
      while (true) {
        const status = await fetch(created.status_url).then(value => value.json());
        if (status.status !== previousStatus) { appendLog(`任务状态：${status.status}`); previousStatus = status.status; }
        if (status.status === 'failed') throw new Error(status.error ?? 'ICP 执行失败');
        if (status.status === 'succeeded') {
          const result = await fetch(status.result_url).then(value => value.json()) as RegistrationResult;
          const round: RegistrationRound = {
            number: registrationRounds.length + 1, jobId: created.job_id, mode: selectedMode,
            parameters, initialPcdToPly, result
          };
          registrationRounds.push(round);
          showActiveRound(round);
          if (result.pcd_to_ply) applyPcdToPly(result.pcd_to_ply);
          renderRound(round);
          appendLog('精配准完成，视口已显示最终结果');
          setRegistrationRunning(false);
          break;
        }
        await sleep(1000);
      }
    } catch (error) {
      appendLog(`失败：${String(error)}`);
      setRegistrationRunning(false);
    }
  });

  let navigationMode: 'orbit' | 'pan' | null = null;
  let navigationOrbitAxis: 'horizontal' | 'vertical' | 'free' | null = null;
  let navigationStartX = 0;
  let navigationStartY = 0;
  let gizmoTransforming = false;
  let translateGizmoHovered = false;
  let rotateGizmoHovered = false;
  let lastX = 0;
  let lastY = 0;
  const onTransformStart = () => { gizmoTransforming = true; navigationMode = null; };
  const onTransformEnd = () => { gizmoTransforming = false; markResultStale(); };
  translateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, onTransformStart);
  translateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, onTransformEnd);
  rotateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, onTransformStart);
  rotateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, onTransformEnd);
  translateGizmo.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => { translateGizmoHovered = Boolean(meshInstance); });
  rotateGizmo.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, meshInstance) => { rotateGizmoHovered = Boolean(meshInstance); });
  const blockGizmoMouseNavigation = (event: MouseEvent) => {
    if (event.button !== 0 || navigationMode) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  canvas.addEventListener('mousedown', blockGizmoMouseNavigation, { capture: true });
  canvas.addEventListener('mousemove', blockGizmoMouseNavigation, { capture: true });
  canvas.addEventListener('mouseup', blockGizmoMouseNavigation, { capture: true });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    const gizmoHovered = activeGizmoMode === 'translate' ? translateGizmoHovered : rotateGizmoHovered;
    if (event.button === 2) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.button === 1) navigationMode = 'pan';
    else if (event.button === 0 && !gizmoHovered) navigationMode = 'orbit';
    else return;
    lastX = event.clientX;
    lastY = event.clientY;
    navigationStartX = event.clientX;
    navigationStartY = event.clientY;
    navigationOrbitAxis = null;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener('pointerup', event => {
    navigationMode = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointercancel', () => { navigationMode = null; });
  window.addEventListener('pointermove', event => {
    if (!navigationMode || gizmoTransforming) return;
    const dx = event.clientX - lastX; const dy = event.clientY - lastY; lastX = event.clientX; lastY = event.clientY;
    if (navigationMode === 'orbit') {
      if (!navigationOrbitAxis) {
        const totalX = event.clientX - navigationStartX;
        const totalY = event.clientY - navigationStartY;
        if (Math.hypot(totalX, totalY) < 5) return;
        navigationOrbitAxis = Math.abs(totalY) > Math.abs(totalX) * 1.5
          ? 'vertical'
          : Math.abs(totalX) > Math.abs(totalY) * 1.5 ? 'horizontal' : 'free';
      }
      orbitCamera(
        (navigationOrbitAxis === 'vertical' ? 0 : dx) * 180 / Math.max(1, viewport.clientWidth),
        (navigationOrbitAxis === 'horizontal' ? 0 : dy) * 180 / Math.max(1, viewport.clientHeight)
      );
    } else {
      const worldTransform = camera.getWorldTransform();
      const right = worldTransform.getX().normalize();
      const up = worldTransform.getY().normalize();
      const viewportHeight = Math.max(1, viewport.clientHeight);
      const worldPerPixel = camera.camera!.projection === pc.PROJECTION_ORTHOGRAPHIC
        ? cameraOrthoHeight * 2 / viewportHeight
        : cameraDistance * 2 * Math.tan(camera.camera!.fov * Math.PI / 360) / viewportHeight;
      cameraTarget.add(right.mulScalar(-dx * worldPerPixel)).add(up.mulScalar(dy * worldPerPixel));
    }
    if (navigationMode === 'pan') updateCamera();
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (camera.camera!.projection === pc.PROJECTION_ORTHOGRAPHIC) {
      cameraOrthoHeight = Math.max(bounds.diagonal * 0.001, cameraOrthoHeight * Math.exp(event.deltaY * 0.001));
      camera.camera!.orthoHeight = cameraOrthoHeight;
    } else {
      cameraDistance = Math.max(bounds.diagonal * 0.001, cameraDistance * Math.exp(event.deltaY * 0.001));
    }
    updateCamera();
  }, { passive: false });
}
