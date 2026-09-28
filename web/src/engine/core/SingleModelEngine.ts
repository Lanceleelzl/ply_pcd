import * as pc from 'playcanvas';
import type { TransformParameters, XYZ } from '../../coordinate-math';
import type { PreviewCloud } from '../../point-cloud';
import { RegistrationApplication } from './Application';
import { InputController } from './InputController';
import { ViewportCameraController } from './ViewportCameraController';
import { SingleModelScene } from '../modules/SingleModelScene';
import { SingleGaussianDisplay } from '../modules/SingleGaussianDisplay';
import { ClippingHandles, type AxisClipState } from '../../clipping-handles';
import { ToolManager } from './ToolManager';
import { TransformGizmoInput } from './TransformGizmoInput';

type SingleModelTool = 'idle' | 'coordinate-query' | 'clipping';
type ClipValuesChanged = (values: {
  axisMin: XYZ; axisMax: XYZ; boxCenter: XYZ; boxSize: XYZ;
}) => void;

export class SingleModelEngine {
  readonly application: RegistrationApplication;
  readonly scene: SingleModelScene;
  readonly camera: ViewportCameraController;
  readonly input: InputController;
  readonly gaussian: SingleGaussianDisplay;
  readonly tools = new ToolManager<SingleModelTool>();
  readonly clippingHandles: ClippingHandles;
  readonly clipTranslate: pc.TranslateGizmo;
  readonly clipRotate: pc.RotateGizmo;
  readonly clipGizmoInput: TransformGizmoInput;
  private axisClip = { enabled: false, min: new pc.Vec3(), max: new pc.Vec3() };
  private boxClip = { enabled: false, worldToBox: new pc.Mat4() };
  private readonly clipBox: pc.Entity;
  private readonly handleBounds: { min: pc.Vec3; max: pc.Vec3 };
  private clipHelpersVisible = true;
  private clipGizmosAttached = false;
  private gizmoTransforming = false;
  private originSides = new pc.Vec3();

  constructor(canvas: HTMLCanvasElement, cloud: PreviewCloud, origin: XYZ, transform: TransformParameters,
    onPick?: (businessPoint: XYZ) => void, onClipValuesChanged?: ClipValuesChanged,
    onToolChanged?: (tool: SingleModelTool) => void) {
    this.application = new RegistrationApplication({ canvas, viewport: canvas.parentElement! });
    try {
      this.scene = new SingleModelScene(this.application.app, cloud, origin, transform);
      this.gaussian = new SingleGaussianDisplay(this.application.app, this.scene.root, origin,
        visible => this.scene.setPointsVisible(visible));
      this.camera = new ViewportCameraController({ camera: this.application.camera, canvas,
        orientationChanged: () => {}, baseDiagonal: this.scene.baseDiagonal,
        getBounds: () => this.scene.bounds() });
      this.clipBox = new pc.Entity('Single model clip box');
      this.application.app.root.addChild(this.clipBox);
      this.handleBounds = this.scene.bounds();
      this.clipTranslate = new pc.TranslateGizmo(this.application.camera.camera!, pc.TranslateGizmo.createLayer(this.application.app, 'Single model clip translation'));
      this.clipTranslate.axisGap = 0.08; this.clipTranslate.axisLineLength = 0.72;
      this.clipTranslate.axisPlaneSize = 0.14; this.clipTranslate.axisPlaneGap = 0.22;
      this.clipRotate = new pc.RotateGizmo(this.application.camera.camera!, pc.RotateGizmo.createLayer(this.application.app, 'Single model clip rotation'));
      this.clipRotate.centerRadius = 0.001; this.clipRotate.ringTolerance = 0.025;
      this.clipGizmoInput = new TransformGizmoInput(this.clipTranslate, this.clipRotate,
        active => { this.gizmoTransforming = active; });
      for (const gizmo of [this.clipTranslate, this.clipRotate]) {
        gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => {
          this.syncBoxFromHelper(); this.emitClipValues(onClipValuesChanged);
        });
        gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
          this.syncBoxFromHelper(); this.emitClipValues(onClipValuesChanged);
        });
      }
      this.tools.register({ id: 'idle', activate: () => onToolChanged?.('idle'), deactivate() {} });
      this.tools.register({ id: 'coordinate-query', activate: () => onToolChanged?.('coordinate-query'), deactivate() {} });
      this.tools.register({ id: 'clipping', activate: () => onToolChanged?.('clipping'), deactivate() {} });
      this.tools.activate('idle');
      const axisState = (): AxisClipState => ({
        min: this.axisClip.min, max: this.axisClip.max,
        minEnabled: { x: this.axisClip.enabled, y: this.axisClip.enabled, z: this.axisClip.enabled },
        maxEnabled: { x: this.axisClip.enabled, y: this.axisClip.enabled, z: this.axisClip.enabled },
      });
      this.clippingHandles = new ClippingHandles(
        this.application.app, this.application.camera, canvas, () => this.clipBox,
        this.handleBounds.min, this.handleBounds.max,
        () => this.tools.isActive('clipping') ? (this.boxClip.enabled ? 'box' : this.axisClip.enabled ? 'axis' : 'off') : 'off',
        axisState,
        (axis, side, value) => {
          this.axisClip[side][axis] = value;
          this.refreshClip();
          this.emitClipValues(onClipValuesChanged);
        },
        () => this.clipHelpersVisible, () => {}, { set() {} },
      );
      this.input = new InputController(canvas, this.camera, {
        pointerMove: event => {
          const handled = this.clippingHandles.pointerMove(event);
          if (handled && this.clippingHandles.dragging) {
            this.syncBoxFromHelper();
            this.emitClipValues(onClipValuesChanged);
          }
          canvas.style.cursor = this.clippingHandles.dragging ? 'grabbing' : this.clippingHandles.hovered ? 'grab' : '';
          return handled;
        },
        pointerLeave: () => this.clippingHandles.pointerLeave(),
        pointerDown: event => {
          if (this.clippingHandles.pointerDown(event)) return true;
          if (!this.tools.isActive('coordinate-query') || !onPick || event.button !== 0) return false;
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const point = this.scene.pickPoint(this.application.camera, x, y);
          if (point) onPick(point);
          return true;
        },
        pointerUp: event => {
          const handled = this.clippingHandles.pointerUp(event);
          if (handled) {
            this.syncBoxFromHelper();
            this.emitClipValues(onClipValuesChanged);
          }
          return handled;
        },
        navigationBlocked: event => event.button === 2 || this.gizmoTransforming
          || (event.button === 0 && this.clipGizmoInput.hovered),
        dragBlocked: () => this.clippingHandles.dragging || this.gizmoTransforming,
      });
      this.application.app.on('update', this.updateHelpers, this);
    } catch (error) {
      this.application.destroy();
      throw error;
    }
  }

  applyTransform(value: TransformParameters): void {
    this.scene.applyTransform(value);
    const bounds = this.scene.bounds(); this.handleBounds.min.copy(bounds.min); this.handleBounds.max.copy(bounds.max);
    this.refreshClip();
  }
  get pickEnabled(): boolean { return this.tools.isActive('coordinate-query'); }
  set pickEnabled(enabled: boolean) { this.setQueryEnabled(enabled); }
  setQueryEnabled(enabled: boolean): void {
    this.tools.activate(enabled ? 'coordinate-query' : this.axisClip.enabled || this.boxClip.enabled ? 'clipping' : 'idle');
    this.syncClipGizmos();
  }
  async showGaussian(url: string, filename: string): Promise<void> {
    await this.gaussian.show(url, filename); this.refreshClip();
  }
  showPoints(): void { this.gaussian.showPoints(); }
  setAxisClip(enabled: boolean, min: XYZ, max: XYZ): void {
    this.axisClip = { enabled, min: new pc.Vec3(...min), max: new pc.Vec3(...max) };
    if (enabled) this.tools.activate('clipping');
    else this.syncClippingTool();
    this.syncClipGizmos();
    this.refreshClip();
  }
  setBoxClip(enabled: boolean, center: XYZ, size: XYZ): void {
    this.clipBox.setPosition(...center);
    this.clipBox.setLocalScale(Math.max(size[0], 0.001), Math.max(size[1], 0.001), Math.max(size[2], 0.001));
    this.boxClip = { enabled, worldToBox: this.clipBox.getWorldTransform().clone().invert() };
    if (enabled) this.tools.activate('clipping');
    else this.syncClippingTool();
    this.syncClipGizmos();
    this.refreshClip();
  }
  setClipHelpersVisible(visible: boolean): void {
    this.clipHelpersVisible = visible; this.syncClipGizmos();
  }
  setAxesVisible(visible: boolean): void { this.scene.setAxesVisible(visible); }
  setOriginPlane(plane: 'xoy' | 'xoz' | 'yoz', visible: boolean, side: number): void {
    this.scene.setOriginPlane(plane, visible);
    if (plane === 'yoz') this.originSides.x = side;
    else if (plane === 'xoz') this.originSides.y = side;
    else this.originSides.z = side;
    this.refreshClip();
  }
  private refreshClip(): void {
    const enabled = this.axisClip.enabled || this.boxClip.enabled;
    const min = this.axisClip.enabled ? this.axisClip.min : new pc.Vec3(-1e30, -1e30, -1e30);
    const max = this.axisClip.enabled ? this.axisClip.max : new pc.Vec3(1e30, 1e30, 1e30);
    const worldToOrigin = this.scene.worldToOrigin();
    this.scene.setClipState(enabled, min, max,
      this.boxClip.enabled, this.boxClip.worldToBox, this.originSides, worldToOrigin);
    this.gaussian.setClip(enabled, min, max,
      this.boxClip.enabled, this.boxClip.worldToBox, this.originSides, worldToOrigin);
  }
  private syncClippingTool(): void {
    if (!this.axisClip.enabled && !this.boxClip.enabled && this.tools.isActive('clipping')) this.tools.activate('idle');
  }
  private syncClipGizmos(): void {
    const show = this.boxClip.enabled && this.clipHelpersVisible && this.tools.isActive('clipping');
    if (show === this.clipGizmosAttached) return;
    if (show) { this.clipTranslate.attach(this.clipBox); this.clipRotate.attach(this.clipBox); }
    else { this.clipTranslate.detach(); this.clipRotate.detach(); }
    this.clipGizmosAttached = show;
  }
  private syncBoxFromHelper(): void {
    if (!this.boxClip.enabled) return;
    this.boxClip.worldToBox = this.clipBox.getWorldTransform().clone().invert();
    this.refreshClip();
  }
  private emitClipValues(callback?: ClipValuesChanged): void {
    const center = this.clipBox.getPosition(); const size = this.clipBox.getLocalScale();
    callback?.({
      axisMin: [this.axisClip.min.x, this.axisClip.min.y, this.axisClip.min.z],
      axisMax: [this.axisClip.max.x, this.axisClip.max.y, this.axisClip.max.z],
      boxCenter: [center.x, center.y, center.z], boxSize: [size.x, size.y, size.z],
    });
  }
  private updateHelpers(): void {
    this.clippingHandles.update();
    if (!this.boxClip.enabled || !this.clipHelpersVisible || !this.tools.isActive('clipping')) return;
    const matrix = this.clipBox.getWorldTransform();
    const corners: pc.Vec3[] = [];
    for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5])
      corners.push(matrix.transformPoint(new pc.Vec3(x, y, z)));
    const edge = (a: number, b: number) => this.application.app.drawLine(corners[a], corners[b], pc.Color.WHITE, false);
    edge(0, 1); edge(0, 2); edge(0, 4); edge(1, 3); edge(1, 5); edge(2, 3);
    edge(2, 6); edge(3, 7); edge(4, 5); edge(4, 6); edge(5, 7); edge(6, 7);
  }
  fit(): void { this.camera.fit(); }
  destroy(): void {
    this.application.app.off('update', this.updateHelpers, this);
    this.clipGizmoInput.destroy(); this.clipTranslate.destroy(); this.clipRotate.destroy();
    this.input.destroy(); this.clippingHandles.destroy(); this.tools.destroy(); this.clipBox.destroy();
    this.gaussian.destroy(); this.scene.destroy(); this.application.destroy();
  }
}
