import * as pc from 'playcanvas';
import type { PreviewCloud } from './point-cloud';
import { invertAffine, offsetXYZ, transformXYZ, type Matrix, type XYZ } from './coordinate-math';
import './coordinate-query.css';

type Model = 'a' | 'b';
const models: Model[] = ['a', 'b'];
interface Result { a_to_b: Matrix; b_to_a: Matrix; moving_model: Model }
interface Options {
  root: HTMLElement; app: pc.Application; camera: pc.Entity; canvas: HTMLCanvasElement;
  entities: Record<Model, pc.Entity>; clouds: Record<Model, PreviewCloud>;
  origins: Record<Model, XYZ>; diagonal: number; sessionId: string;
  businessMatrices: Record<Model, Matrix>;
  localToDisplay: (model: Model) => Matrix;
  signature: () => string;
  setOriginal: (original: boolean) => void;
  lock: (active: boolean) => void;
  visiblePoint: (model: Model, world: pc.Vec3) => boolean;
}

// Business coordinates stay in Number arrays; engine matrices are used only for display/picking.
export class CoordinateQuery {
  active = false;
  hovered = false;
  dragging = false;
  private picking = false;
  private clippingActive = false;
  private original = false;
  private result: Result | null = null;
  private jobId = '';
  private source: Model = 'a';
  private points: Record<Model, XYZ> | null = null;
  private signature = '';
  private panel: HTMLElement;
  private toggle: HTMLButtonElement;
  private stateButton: HTMLButtonElement;
  private gizmo: pc.TranslateGizmo;
  private anchor = new pc.Entity('Coordinate query handle');
  private markers: Record<Model, pc.Entity>;
  private labels: Record<Model, HTMLElement>;
  private axesVisible: Record<Model, boolean> = { a: false, b: false };
  private axisLabels: Record<Model, HTMLElement[]>;
  private message: HTMLElement;

  constructor(private options: Options) {
    const { root, app, camera } = options;
    const toolbar = root.querySelector('.viewport-toolbar')!;
    toolbar.insertAdjacentHTML('beforeend', '<button id="coordinate-query" disabled title="完成 ICP 后可查询坐标对">坐标查询</button><button id="origin-a" aria-pressed="false">A 原点／轴</button><button id="origin-b" aria-pressed="false">B 原点／轴</button>');
    toolbar.querySelector('strong')?.remove();
    const groups = [
      ['配准与视图', ['reset', 'fit', 'clipping-toggle']],
      ['模型显隐', ['toggle-model-a', 'toggle-model-b']],
      ['高斯显示', ['gaussian-model-a', 'gaussian-model-b']],
      ['坐标工具', ['coordinate-query', 'origin-a', 'origin-b']],
    ] as const;
    for (const [label, ids] of groups) {
      const group = document.createElement('div');
      group.className = 'viewport-tool-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      group.innerHTML = `<span class="tool-group-label">${label}</span>`;
      ids.forEach(id => group.append(root.querySelector(`#${id}`)!));
      toolbar.append(group);
    }
    toolbar.querySelector('.model-visibility')?.remove();
    root.querySelector('.viewport')!.insertAdjacentHTML('beforeend', `<section class="coordinate-panel" hidden>
      <div class="coordinate-title"><strong>坐标查询</strong><button data-query="close">返回配准编辑</button></div>
      <button data-query="state">当前位置：配准位置｜切换原始位置</button>
      <div class="coordinate-actions coordinate-point-tools" role="group" aria-label="选择编辑点与取点"><button data-move-point="a">移动 A 点</button><button data-move-point="b">移动 B 点</button><button data-query="pick">场景取点</button><button data-query="clear">清除点</button></div>
      <div class="coordinate-fields">${models.map(model => `<fieldset><legend>${model.toUpperCase()} 业务坐标（${model === 'a' ? '红色' : '蓝色'}）</legend>${['X', 'Y', 'Z'].map((axis, index) => `<label>${axis}<input data-model="${model}" data-index="${index}" type="number" step="0.001" value="0"></label>`).join('')}<button data-query="copy-${model}">复制 ${model.toUpperCase()} 坐标</button></fieldset>`).join('')}</div>
      <button data-query="copy-pair">复制坐标对</button><p class="coordinate-message"></p>
      <small>坐标属于各模型业务坐标系；切换位置仅改变显示。取点使用轻量中心点预览，Gaussian 视觉表面可能与中心点不同。</small>
    </section>`);
    this.panel = root.querySelector('.coordinate-panel')!;
    this.toggle = root.querySelector('#coordinate-query')!;
    this.stateButton = this.panel.querySelector('[data-query="state"]')!;
    this.message = this.panel.querySelector('.coordinate-message')!;
    this.markers = { a: this.makeMarker('a', new pc.Color(1, 0.15, 0.12)), b: this.makeMarker('b', new pc.Color(0.12, 0.5, 1)) };
    const label = (text: string) => {
      const element = document.createElement('span'); element.className = 'coordinate-label'; element.textContent = text;
      root.querySelector('.viewport')!.append(element); element.hidden = true; return element;
    };
    this.labels = { a: label('A 点'), b: label('B 点') };
    this.axisLabels = { a: ['0', 'X', 'Y', 'Z'].map(axis => label(`A-${axis}`)), b: ['0', 'X', 'Y', 'Z'].map(axis => label(`B-${axis}`)) };
    app.root.addChild(this.anchor);
    this.gizmo = new pc.TranslateGizmo(camera.camera!, pc.TranslateGizmo.createLayer(app, 'Coordinate point translation'));
    this.gizmo.mouseButtons[1] = this.gizmo.mouseButtons[2] = false;
    this.gizmo.axisGap = 0.15;
    this.gizmo.axisLineLength = 1.0;
    this.gizmo.axisPlaneGap = 0.3;
    this.gizmo.axisPlaneSize = 0.25;
    this.gizmo.on(pc.Gizmo.EVENT_POINTERMOVE, (_x: number, _y: number, mesh: unknown) => { this.hovered = Boolean(mesh); });
    this.gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => { this.dragging = true; });
    this.gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => {
      const local = transformXYZ(invertAffine(options.localToDisplay(this.source)), this.anchor.getPosition().toArray() as XYZ);
      const filePoint = offsetXYZ(local, options.origins[this.source]);
      this.setPoint(transformXYZ(options.businessMatrices[this.source], filePoint), false);
    });
    this.gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => { this.dragging = false; this.refresh(); });
    this.toggle.addEventListener('click', () => this.active ? this.close() : this.open());
    this.panel.querySelector('[data-query="close"]')!.addEventListener('click', () => this.close());
    this.stateButton.addEventListener('click', () => {
      this.original = !this.original; this.applyPresentation(); this.refresh();
    });
    this.panel.querySelectorAll<HTMLButtonElement>('[data-move-point]').forEach(button => button.addEventListener('click', () => {
      this.source = button.dataset.movePoint as Model;
      this.picking = false; this.refresh();
    }));
    this.panel.querySelector('[data-query="pick"]')!.addEventListener('click', () => {
      this.picking = true; this.gizmo.detach(); this.message.textContent = `请点击模型 ${this.source.toUpperCase()} 的可见中心点。`;
    });
    this.panel.querySelector('[data-query="clear"]')!.addEventListener('click', () => { this.points = null; this.picking = false; this.refresh(); });
    this.panel.querySelectorAll<HTMLInputElement>('input').forEach(input => input.addEventListener('change', () => {
      const values = Array.from(this.panel.querySelectorAll<HTMLInputElement>(`input[data-model="${this.source}"]`)).map(field => Number(field.value));
      if (values.every(Number.isFinite) && Array.from(this.panel.querySelectorAll<HTMLInputElement>(`input[data-model="${this.source}"]`)).every(field => field.value !== '')) { this.picking = false; this.setPoint(values as XYZ); }
      else this.message.textContent = '请输入三个有效的有限坐标值。';
    }));
    for (const action of ['a', 'b', 'pair']) this.panel.querySelector(`[data-query="copy-${action}"]`)!.addEventListener('click', async () => {
      if (!this.points) return;
      const data = action === 'pair' ? JSON.stringify({ session_id: options.sessionId, job_id: this.jobId, model_a: this.points.a, model_b: this.points.b }, null, 2) : this.points[action as Model].join(' ');
      try { await navigator.clipboard.writeText(data); this.message.textContent = '已复制。'; }
      catch { this.message.textContent = '剪贴板不可用，请从坐标框复制。'; }
    });
    models.forEach(model => root.querySelector(`#origin-${model}`)!.addEventListener('click', event => {
      this.axesVisible[model] = !this.axesVisible[model];
      (event.currentTarget as HTMLElement).classList.toggle('active', this.axesVisible[model]);
      (event.currentTarget as HTMLElement).setAttribute('aria-pressed', String(this.axesVisible[model]));
    }));
    app.on('update', () => this.update());
  }

  private makeMarker(model: Model, color: pc.Color): pc.Entity {
    const entity = new pc.Entity(`Query ${model}`); entity.addComponent('render', { type: 'sphere' });
    const material = new pc.StandardMaterial(); material.diffuse = color; material.emissive = color; material.depthTest = false;
    material.update(); entity.render!.meshInstances[0].material = material;
    if (model === 'b') entity.render!.meshInstances[0].renderStyle = pc.RENDERSTYLE_WIREFRAME;
    this.options.app.root.addChild(entity); entity.enabled = false; return entity;
  }

  private currentSignature(): string {
    return this.options.signature();
  }

  setResult(result: Result, jobId: string): void {
    this.result = result; this.jobId = jobId; this.signature = this.currentSignature(); this.toggle.disabled = false;
    this.toggle.title = '使用本轮 ICP 矩阵查询 A／B 业务坐标对';
    if (this.points) this.setPoint(this.points[this.source]);
  }

  invalidate(): void {
    if (this.active) this.close(); this.result = null; this.toggle.disabled = true;
    this.toggle.title = '模型关系已改变，请重新完成 ICP';
  }

  private open(): void {
    if (!this.result || this.signature !== this.currentSignature()) { this.invalidate(); return; }
    this.active = true; this.panel.hidden = false; this.toggle.classList.add('active'); this.options.lock(true);
    this.refresh();
  }

  close(): void {
    this.original = false; this.applyPresentation(); this.active = false; this.picking = false;
    this.panel.hidden = true; this.toggle.classList.remove('active'); this.gizmo.detach(); this.hovered = false;
    this.options.lock(false); this.refresh();
  }

  private applyPresentation(): void {
    if (this.result) this.options.setOriginal(this.original);
  }

  private setPoint(point: XYZ, attach = true): void {
    if (!this.result) return;
    this.points = this.source === 'a' ? { a: point, b: transformXYZ(this.result.a_to_b, point) }
      : { b: point, a: transformXYZ(this.result.b_to_a, point) };
    this.refresh(attach);
  }

  private displayPoint(model: Model, point: XYZ): pc.Vec3 {
    const filePoint = transformXYZ(invertAffine(this.options.businessMatrices[model]), point);
    return this.displayFilePoint(model, filePoint);
  }

  private displayFilePoint(model: Model, filePoint: XYZ): pc.Vec3 {
    return new pc.Vec3(...transformXYZ(this.options.localToDisplay(model), offsetXYZ(filePoint, this.options.origins[model], -1)));
  }

  private refresh(attach = true): void {
    for (const action of ['clear', 'copy-a', 'copy-b', 'copy-pair']) {
      (this.panel.querySelector(`[data-query="${action}"]`) as HTMLButtonElement).disabled = !this.points;
    }
    this.panel.querySelectorAll<HTMLButtonElement>('[data-move-point]').forEach(button => {
      button.classList.toggle('active', button.dataset.movePoint === this.source);
      button.setAttribute('aria-pressed', String(button.dataset.movePoint === this.source));
    });
    (this.panel.querySelector('[data-query="pick"]') as HTMLButtonElement).disabled = this.clippingActive;
    this.stateButton.textContent = this.original ? '当前位置：原始位置｜切换配准位置' : '当前位置：配准位置｜切换原始位置';
    this.panel.querySelectorAll<HTMLInputElement>('input').forEach(input => {
      const model = input.dataset.model as Model;
      input.disabled = model !== this.source;
      if (document.activeElement !== input) input.value = this.points ? String(this.points[model][Number(input.dataset.index)]) : '0';
    });
    this.message.title = `转换依据：ICP ${this.jobId}`;
    this.message.textContent = this.points ? '已按 ICP 矩阵换算，坐标不随显示状态变化。' : '使用 ICP 结果，可场景取点或直接输入 XYZ。';
    if (attach) {
      this.gizmo.detach(); this.hovered = false;
      if (this.points && this.active && !this.picking && !this.clippingActive) {
        this.anchor.setPosition(this.displayPoint(this.source, this.points[this.source])); this.gizmo.attach(this.anchor);
      }
    }
  }

  pointerDown(event: PointerEvent): boolean {
    if (!this.active || this.clippingActive || !this.picking || event.button !== 0) return false;
    const { canvas, camera, clouds, entities, origins } = this.options;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const radius = 9;
    const cloud = clouds[this.source]; const entity = entities[this.source];
    let best = -1; let bestDepth = Infinity;
    const local = new pc.Vec3(); const world = new pc.Vec3(); const screen = new pc.Vec3();
    if (entity.enabled) for (let index = 0; index < cloud.count; index++) {
      local.set(cloud.positions[index * 3], cloud.positions[index * 3 + 1], cloud.positions[index * 3 + 2]);
      entity.getWorldTransform().transformPoint(local, world);
      if (!this.options.visiblePoint(this.source, world)) continue;
      const depth = world.clone().sub(camera.getPosition()).dot(camera.forward);
      if (depth <= camera.camera!.nearClip || depth >= bestDepth) continue;
      camera.camera!.worldToScreen(world, screen);
      if ((screen.x - x) ** 2 + (screen.y - y) ** 2 <= radius ** 2) { best = index; bestDepth = depth; }
    }
    if (best >= 0) {
      this.picking = false;
      const filePoint = offsetXYZ([cloud.positions[best * 3], cloud.positions[best * 3 + 1], cloud.positions[best * 3 + 2]], origins[this.source]);
      this.setPoint(transformXYZ(this.options.businessMatrices[this.source], filePoint));
    } else this.message.textContent = '未命中可见点，请重新点击或输入坐标。';
    return true;
  }

  private placeLabel(element: HTMLElement, world: pc.Vec3, offset: number): void {
    const { camera, canvas } = this.options;
    const screen = camera.camera!.worldToScreen(world);
    element.hidden = world.clone().sub(camera.getPosition()).dot(camera.forward) <= 0;
    const x = screen.x;
    const y = screen.y;
    element.hidden ||= x < 0 || x > canvas.clientWidth || y < 0 || y > canvas.clientHeight;
    element.style.left = `${x + 10}px`; element.style.top = `${y + offset}px`;
  }

  setClippingActive(active: boolean): void {
    if (this.clippingActive === active) return;
    this.clippingActive = active;
    if (active) this.picking = false;
    this.refresh();
    if (active) this.message.textContent = '正在编辑剖切；关闭剖切面板后恢复点移动手柄，剖切效果仍保留。';
  }

  private update(): void {
    if (!this.active && this.result && this.signature !== this.currentSignature()) this.invalidate();
    for (const model of models) {
      const marker = this.markers[model]; marker.enabled = this.active && Boolean(this.points);
      this.labels[model].hidden = !marker.enabled;
      if (marker.enabled && this.points) {
        const position = this.displayPoint(model, this.points[model]); marker.setPosition(position);
        const camera = this.options.camera.camera!;
        const depth = Math.abs(position.clone().sub(this.options.camera.getPosition()).dot(this.options.camera.forward));
        const size = (camera.projection === pc.PROJECTION_ORTHOGRAPHIC ? camera.orthoHeight * 2 : 2 * depth * Math.tan(camera.fov * Math.PI / 360)) / Math.max(1, this.options.canvas.clientHeight) * 11;
        const diameter = model === 'b' ? size * 1.6 : size;
        marker.setLocalScale(diameter, diameter, diameter);
        this.placeLabel(this.labels[model], position, model === 'a' ? -19 : 3);
      }
      this.axisLabels[model].forEach(label => { label.hidden = true; });
      if (this.axesVisible[model]) {
        const zero: XYZ = [0, 0, 0]; const start = this.displayFilePoint(model, zero);
        this.placeLabel(this.axisLabels[model][0], start, model === 'a' ? -20 : 3);
        const colors = [pc.Color.RED, pc.Color.GREEN, pc.Color.BLUE];
        for (let axis = 0; axis < 3; axis++) {
          const end: XYZ = [0, 0, 0]; end[axis] = Math.max(0.1, this.options.diagonal * 0.12);
          const world = this.displayFilePoint(model, end);
          this.options.app.drawLine(start, world, colors[axis], false);
          this.placeLabel(this.axisLabels[model][axis + 1], world, model === 'a' ? -20 : 3);
        }
      }
    }
  }
}
