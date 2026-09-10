import * as pc from 'playcanvas';
import { createApp, h, reactive, type App } from 'vue';
import OriginPlaneForm, { type OriginPlaneState } from './views/workbench/OriginPlaneForm.vue';
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
  private readonly form: App;
  private readonly state = reactive<OriginPlaneState>({
    a: { xoy: { visible: false, side: 0 }, xoz: { visible: false, side: 0 }, yoz: { visible: false, side: 0 } },
    b: { xoy: { visible: false, side: 0 }, xoz: { visible: false, side: 0 }, yoz: { visible: false, side: 0 } },
  });
  private readonly togglePanel = () => { this.panel.hidden = !this.panel.hidden; };

  constructor(
    root: HTMLElement,
    private readonly app: pc.Application,
    entities: Record<Model, pc.Entity>,
    origins: Record<Model, XYZ>,
    diagonals: Record<Model, number>,
    private readonly modelVisible: Record<Model, boolean>,
  ) {
    this.toggle = root.querySelector('#origin-planes-toggle')!;
    root.querySelector('.viewport')!.insertAdjacentHTML('beforeend', '<section class="origin-planes-panel" hidden></section>');
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
    this.form = createApp({ render: () => h(OriginPlaneForm, {
      state: this.state,
      onVisible: (model: Model, plane: Plane, value: boolean) => { this.state[model][plane].visible = value; this.refresh(); },
      onSide: (model: Model, plane: Plane, value: number) => { this.state[model][plane].side = value; this.refresh(); },
      onClose: () => { this.panel.hidden = true; },
      onClear: () => {
        models.forEach(model => planes.forEach(plane => { Object.assign(this.state[model][plane.id], { visible: false, side: 0 }); }));
        this.refresh();
      },
    }) });
    this.form.mount(this.panel);
    this.toggle.addEventListener('click', this.togglePanel);
    this.app.on('update', this.refreshVisuals, this);
    this.refresh();
  }

  private refresh(): void {
    const active = models.some(model => planes.some(plane =>
      this.state[model][plane.id].visible || this.state[model][plane.id].side !== 0));
    this.toggle.classList.toggle('active', active);
    this.toggle.setAttribute('aria-pressed', String(active));
    this.refreshVisuals();
  }

  private refreshVisuals(): void {
    models.forEach(model => planes.forEach(plane => {
      this.visuals[model][plane.id].enabled = this.modelVisible[model]
        && this.state[model][plane.id].visible;
    }));
  }

  clipSides(model: Model): pc.Vec3 {
    const value = (plane: Plane) => this.state[model][plane].side;
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

  destroy(): void {
    this.toggle.removeEventListener('click', this.togglePanel);
    this.form.unmount();
    this.app.off('update', this.refreshVisuals, this);
    models.forEach(model => this.frames[model].destroy());
    this.panel.remove();
  }
}
