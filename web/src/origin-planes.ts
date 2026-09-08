import * as pc from 'playcanvas';
import type { XYZ } from './coordinate-math';

type Model = 'a' | 'b';
type Plane = 'xoy' | 'xoz' | 'yoz';

const models: Model[] = ['a', 'b'];
const planes: Array<{ id: Plane; label: string; normal: 'x' | 'y' | 'z'; color: pc.Color }> = [
  { id: 'xoy', label: 'XOY', normal: 'z', color: new pc.Color(0.20, 0.48, 1.0) },
  { id: 'xoz', label: 'XOZ', normal: 'y', color: new pc.Color(0.20, 0.82, 0.48) },
  { id: 'yoz', label: 'YOZ', normal: 'x', color: new pc.Color(1.0, 0.32, 0.28) },
];

export class OriginPlaneController {
  private readonly panel: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly frames: Record<Model, pc.Entity>;
  private readonly visuals: Record<Model, Record<Plane, pc.Entity>>;
  private readonly worldToOrigin = { a: new pc.Mat4(), b: new pc.Mat4() };

  constructor(
    root: HTMLElement,
    app: pc.Application,
    entities: Record<Model, pc.Entity>,
    origins: Record<Model, XYZ>,
    diagonals: Record<Model, number>,
    private readonly modelVisible: Record<Model, boolean>,
  ) {
    this.toggle = root.querySelector('#origin-planes-toggle')!;
    root.querySelector('.viewport')!.insertAdjacentHTML('beforeend', `<section class="origin-planes-panel" hidden>
      <div class="origin-planes-title"><strong>模型原点平面</strong><button data-origin-plane-close title="关闭面板">×</button></div>
      <p>平面经过各自模型原点并跟随模型姿态。剖切只作用于对应模型。</p>
      ${models.map(model => `<fieldset><legend>模型 ${model.toUpperCase()}</legend>${planes.map(plane => `<div class="origin-plane-row">
        <label><input type="checkbox" data-origin-plane-visible="${model}-${plane.id}">显示 ${plane.label}</label>
        <select aria-label="模型 ${model.toUpperCase()} ${plane.label} 剖切" data-origin-plane-clip="${model}-${plane.id}"><option value="0">不剖切</option><option value="1">保留 +${plane.normal.toUpperCase()}</option><option value="-1">保留 −${plane.normal.toUpperCase()}</option></select>
      </div>`).join('')}</fieldset>`).join('')}
      <button class="full-width" data-origin-plane-clear>全部关闭</button>
    </section>`);
    this.panel = root.querySelector('.origin-planes-panel')!;
    this.frames = { a: new pc.Entity('A origin frame'), b: new pc.Entity('B origin frame') };
    this.visuals = { a: {} as Record<Plane, pc.Entity>, b: {} as Record<Plane, pc.Entity> };
    models.forEach(model => {
      const frame = this.frames[model];
      frame.setLocalPosition(-origins[model][0], -origins[model][1], -origins[model][2]);
      entities[model].addChild(frame);
      const size = Math.max(diagonals[model] * 0.7, 0.1);
      planes.forEach(plane => {
        const visual = new pc.Entity(`${model.toUpperCase()} ${plane.label} origin plane`);
        visual.addComponent('render', { type: 'plane' });
        visual.setLocalScale(size, 1, size);
        if (plane.id === 'xoy') visual.setLocalEulerAngles(90, 0, 0);
        if (plane.id === 'yoz') visual.setLocalEulerAngles(0, 0, 90);
        const material = new pc.StandardMaterial();
        material.diffuse = plane.color; material.emissive = plane.color.clone().mulScalar(0.25);
        material.opacity = 0.18; material.blendType = pc.BLEND_NORMAL; material.depthWrite = false;
        material.cull = pc.CULLFACE_NONE; material.update();
        visual.render!.meshInstances.forEach(instance => { instance.material = material; });
        frame.addChild(visual); visual.enabled = false; this.visuals[model][plane.id] = visual;
      });
    });
    this.toggle.addEventListener('click', () => { this.panel.hidden = !this.panel.hidden; });
    this.panel.querySelector('[data-origin-plane-close]')!.addEventListener('click', () => { this.panel.hidden = true; });
    this.panel.querySelectorAll('input,select').forEach(control => control.addEventListener('change', () => this.refresh()));
    this.panel.querySelector('[data-origin-plane-clear]')!.addEventListener('click', () => {
      this.panel.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = false; });
      this.panel.querySelectorAll<HTMLSelectElement>('select').forEach(select => { select.value = '0'; });
      this.refresh();
    });
    app.on('update', () => this.refreshVisuals());
    this.refresh();
  }

  private key(model: Model, plane: Plane): string { return `${model}-${plane}`; }

  private refresh(): void {
    const active = models.some(model => planes.some(plane =>
      this.panel.querySelector<HTMLInputElement>(`[data-origin-plane-visible="${this.key(model, plane.id)}"]`)!.checked
      || this.panel.querySelector<HTMLSelectElement>(`[data-origin-plane-clip="${this.key(model, plane.id)}"]`)!.value !== '0'));
    this.toggle.classList.toggle('active', active);
    this.toggle.setAttribute('aria-pressed', String(active));
    this.refreshVisuals();
  }

  private refreshVisuals(): void {
    models.forEach(model => planes.forEach(plane => {
      this.visuals[model][plane.id].enabled = this.modelVisible[model]
        && this.panel.querySelector<HTMLInputElement>(`[data-origin-plane-visible="${this.key(model, plane.id)}"]`)!.checked;
    }));
  }

  clipSides(model: Model): pc.Vec3 {
    const value = (plane: Plane) => Number(this.panel.querySelector<HTMLSelectElement>(`[data-origin-plane-clip="${this.key(model, plane)}"]`)!.value);
    return new pc.Vec3(value('yoz'), value('xoz'), value('xoy'));
  }

  getWorldToOrigin(model: Model): pc.Mat4 {
    return this.worldToOrigin[model].copy(this.frames[model].getWorldTransform()).invert();
  }

  visiblePoint(model: Model, world: pc.Vec3): boolean {
    const side = this.clipSides(model);
    const local = this.getWorldToOrigin(model).transformPoint(world);
    const inside = (value: number, coordinate: number) => value === 0 || (value > 0 ? coordinate >= 0 : coordinate <= 0);
    return inside(side.x, local.x) && inside(side.y, local.y) && inside(side.z, local.z);
  }
}
