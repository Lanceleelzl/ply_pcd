import type { CoordinatePanelView, CoordinateLabelsView } from './coordinate-query-state';
import * as pc from 'playcanvas';
import type { PreviewCloud } from '../../point-cloud';
import { invertAffine, offsetXYZ, transformXYZ, type Matrix, type XYZ } from '../../coordinate-math';
import { pickVisiblePreviewPoint } from './coordinate-query-picking.ts';

type Model = 'a' | 'b';
const models: Model[] = ['a', 'b'];
interface Result { a_to_b: Matrix; b_to_a: Matrix; moving_model: Model }
interface Options {
  panel: CoordinatePanelView;
  labels: CoordinateLabelsView;
  toolbar: { setAvailable: (available: boolean, title: string) => void; setActive: (active: boolean) => void };
  app: pc.Application; camera: pc.Entity; canvas: HTMLCanvasElement;
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
  private gizmo: pc.TranslateGizmo;
  private anchor = new pc.Entity('Coordinate query handle');
  private markers: Record<Model, pc.Entity>;
  private axesVisible: Record<Model, boolean> = { a: false, b: false };

  constructor(private options: Options) {
    const { app, camera } = options;
    this.markers = { a: this.makeMarker('a', new pc.Color(1, 0.15, 0.12)), b: this.makeMarker('b', new pc.Color(0.12, 0.5, 1)) };
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
    app.on('update', this.update, this);
  }

  setSource(model: Model): void { this.source = model; this.picking = false; this.refresh(); }

  setCoordinates(values: XYZ): void { this.picking = false; this.setPoint(values); }

  handlePanelAction(action: string): void {
    if (action === 'close') this.close();
    else if (action === 'invalid') this.options.panel.state.message = '请输入三个有效的有限坐标值。';
    else if (action === 'state') { this.original = !this.original; this.applyPresentation(); this.refresh(); }
    else if (action === 'pick') {
      this.picking = true; this.gizmo.detach();
      this.options.panel.state.message = `请点击模型 ${this.source.toUpperCase()} 的可见中心点。`;
    } else if (action === 'clear') { this.points = null; this.picking = false; this.refresh(); }
    else if (action.startsWith('copy-')) void this.copyCoordinates(action.slice(5));
  }

  private async copyCoordinates(action: string): Promise<void> {
    if (!this.points || !['a', 'b', 'pair'].includes(action)) return;
    const data = action === 'pair' ? JSON.stringify({ session_id: this.options.sessionId, job_id: this.jobId,
      model_a: this.points.a, model_b: this.points.b }, null, 2) : this.points[action as Model].join(' ');
    try { await this.options.panel.copyText(data); this.options.panel.state.message = '已复制。'; }
    catch { this.options.panel.state.message = '剪贴板不可用，请从坐标框复制。'; }
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
    this.result = result; this.jobId = jobId; this.signature = this.currentSignature(); this.options.toolbar.setAvailable(true, '使用本轮 ICP 矩阵查询 A／B 业务坐标对');
    if (this.points) this.setPoint(this.points[this.source]);
  }

  invalidate(): void {
    if (this.active) this.close(); this.result = null; this.options.toolbar.setAvailable(false, '模型关系已改变，请重新完成 ICP');
  }

  toggleQuery(): void { this.active ? this.close() : this.open(); }

  toggleOrigin(model: Model): boolean {
    this.axesVisible[model] = !this.axesVisible[model];
    return this.axesVisible[model];
  }

  private open(): void {
    if (!this.result || this.signature !== this.currentSignature()) { this.invalidate(); return; }
    this.active = true; this.options.panel.setVisible(true); this.options.toolbar.setActive(true); this.options.lock(true);
    this.refresh();
  }

  close(): void {
    this.original = false; this.applyPresentation(); this.active = false; this.picking = false;
    this.options.panel.setVisible(false); this.options.toolbar.setActive(false); this.gizmo.detach(); this.hovered = false;
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
    Object.assign(this.options.panel.state, { source: this.source, points: this.points, original: this.original,
      clippingActive: this.clippingActive, jobId: this.jobId });
    this.options.panel.state.message = this.points ? '已按 ICP 矩阵换算，坐标不随显示状态变化。' : '使用 ICP 结果，可场景取点或直接输入 XYZ。';
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
    const best = entity.enabled ? pickVisiblePreviewPoint({
      cloud,
      localToWorld: entity.getWorldTransform(),
      cameraPosition: camera.getPosition(),
      cameraForward: camera.forward,
      nearClip: camera.camera!.nearClip,
      screenX: x,
      screenY: y,
      radius,
      visiblePoint: world => this.options.visiblePoint(this.source, world),
      worldToScreen: (world, screen) => { camera.camera!.worldToScreen(world, screen); },
    }) : -1;
    if (best >= 0) {
      this.picking = false;
      const filePoint = offsetXYZ([cloud.positions[best * 3], cloud.positions[best * 3 + 1], cloud.positions[best * 3 + 2]], origins[this.source]);
      this.setPoint(transformXYZ(this.options.businessMatrices[this.source], filePoint));
    } else this.options.panel.state.message = '未命中可见点，请重新点击或输入坐标。';
    return true;
  }

  private placeLabel(model: Model, index: number, world: pc.Vec3, offset: number): void {
    const { camera, canvas, labels } = this.options;
    const screen = camera.camera!.worldToScreen(world);
    const visible = world.clone().sub(camera.getPosition()).dot(camera.forward) > 0
      && screen.x >= 0 && screen.x <= canvas.clientWidth && screen.y >= 0 && screen.y <= canvas.clientHeight;
    labels.set(model, index, visible ? { x: screen.x + 10, y: screen.y + offset } : null);
  }

  setClippingActive(active: boolean): void {
    if (this.clippingActive === active) return;
    this.clippingActive = active;
    if (active) this.picking = false;
    this.refresh();
    if (active) this.options.panel.state.message = '正在编辑剖切；关闭剖切面板后恢复点移动手柄，剖切效果仍保留。';
  }

  destroy(): void {
    if (this.active) this.close();
    this.options.app.off('update', this.update, this);
    this.gizmo.destroy();
    this.anchor.destroy();
    models.forEach(model => {
      this.markers[model].destroy();
    });
  }

  private update(): void {
    if (!this.active && this.result && this.signature !== this.currentSignature()) this.invalidate();
    for (const model of models) {
      const marker = this.markers[model]; marker.enabled = this.active && Boolean(this.points);
      if (!marker.enabled) this.options.labels.set(model, 0, null);
      if (marker.enabled && this.points) {
        const position = this.displayPoint(model, this.points[model]); marker.setPosition(position);
        const camera = this.options.camera.camera!;
        const depth = Math.abs(position.clone().sub(this.options.camera.getPosition()).dot(this.options.camera.forward));
        const size = (camera.projection === pc.PROJECTION_ORTHOGRAPHIC ? camera.orthoHeight * 2 : 2 * depth * Math.tan(camera.fov * Math.PI / 360)) / Math.max(1, this.options.canvas.clientHeight) * 11;
        const diameter = model === 'b' ? size * 1.6 : size;
        marker.setLocalScale(diameter, diameter, diameter);
        this.placeLabel(model, 0, position, model === 'a' ? -19 : 3);
      }
      if (!this.axesVisible[model]) for (let index = 1; index <= 4; index++) this.options.labels.set(model, index, null);
      if (this.axesVisible[model]) {
        const zero: XYZ = [0, 0, 0]; const start = this.displayFilePoint(model, zero);
        this.placeLabel(model, 1, start, model === 'a' ? -20 : 3);
        const colors = [pc.Color.RED, pc.Color.GREEN, pc.Color.BLUE];
        for (let axis = 0; axis < 3; axis++) {
          const end: XYZ = [0, 0, 0]; end[axis] = Math.max(0.1, this.options.diagonal * 0.12);
          const world = this.displayFilePoint(model, end);
          this.options.app.drawLine(start, world, colors[axis], false);
          this.placeLabel(model, axis + 2, world, model === 'a' ? -20 : 3);
        }
      }
    }
  }
}
