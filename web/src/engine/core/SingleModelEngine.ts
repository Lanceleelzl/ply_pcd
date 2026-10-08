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
  private readonly queryAnchor: pc.Entity;
  private readonly queryGizmo: pc.TranslateGizmo;
  private queryHovered = false;
  private queryDragging = false;
  private queryPoint: XYZ | null = null;
  private queryAttached = false;
  private queryPicking = false;
  private capturePointer: { x: number; y: number } | null = null;
  private captureDirty = false;
  private captureCamera = '';
  private pickGesture: { x: number; y: number; dragged: boolean } | null = null;
  private sceneAxesVisible = false;

  constructor(canvas: HTMLCanvasElement, cloud: PreviewCloud, origin: XYZ, transform: TransformParameters,
    onPick?: (businessPoint: XYZ) => void, onClipValuesChanged?: ClipValuesChanged,
    onToolChanged?: (tool: SingleModelTool) => void,
    private readonly onPickingChanged?: (picking: boolean) => void,
    private readonly onCapture?: (capture: { point: XYZ; x: number; y: number } | null) => void,
    private readonly onSceneAxes?: (labels: Array<{ text: string; x: number; y: number; color: string }>) => void) {
    this.application = new RegistrationApplication({ canvas, viewport: canvas.parentElement! });
    try {
      this.scene = new SingleModelScene(this.application.app, cloud, origin, transform);
      this.gaussian = new SingleGaussianDisplay(this.application.app, this.scene.root, origin,
        visible => this.scene.setPointsVisible(visible));
      this.camera = new ViewportCameraController({ camera: this.application.camera, canvas,
        orientationChanged: () => {}, baseDiagonal: this.scene.baseDiagonal,
        getBounds: () => this.scene.bounds() });
      this.queryAnchor = new pc.Entity('Single model query point');
      this.application.app.root.addChild(this.queryAnchor);
      this.queryGizmo = new pc.TranslateGizmo(this.application.camera.camera!, pc.TranslateGizmo.createLayer(this.application.app, 'Single model query translation'));
      this.queryGizmo.mouseButtons[1] = this.queryGizmo.mouseButtons[2] = false;
      this.queryGizmo.axisGap = 0.15; this.queryGizmo.axisLineLength = 1;
      this.queryGizmo.axisPlaneGap = 0.3; this.queryGizmo.axisPlaneSize = 0.25;
      this.queryGizmo.on(pc.Gizmo.EVENT_POINTERMOVE, (_x: number, _y: number, hit: unknown) => { this.queryHovered = Boolean(hit); });
      this.queryGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => { this.queryDragging = true; });
      const updateQuery = () => {
        const position = this.queryAnchor.getPosition();
        const origin = this.scene.displayOrigin;
        this.queryPoint = [position.x + origin[0], position.y + origin[1], position.z + origin[2]];
        onPick?.([...this.queryPoint]);
      };
      this.queryGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, updateQuery);
      this.queryGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => { updateQuery(); this.queryDragging = false; });
      this.clipBox = new pc.Entity('Single model clip box');
      this.application.app.root.addChild(this.clipBox);
      this.handleBounds = this.scene.bounds();
      this.clipTranslate = new pc.TranslateGizmo(this.application.camera.camera!, pc.TranslateGizmo.createLayer(this.application.app, 'Single model clip translation'));
      this.clipTranslate.axisGap = 0.08; this.clipTranslate.axisLineLength = 0.72;
      this.clipTranslate.axisPlaneSize = 0.14; this.clipTranslate.axisPlaneGap = 0.22;
      this.clipTranslate.flipPlanes = true;
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
          if (this.queryPicking && this.tools.isActive('coordinate-query')) {
            canvas.style.cursor = 'crosshair';
            const rect = canvas.getBoundingClientRect();
            this.capturePointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
            this.captureDirty = true;
            if (this.pickGesture && Math.hypot(event.clientX - this.pickGesture.x, event.clientY - this.pickGesture.y) >= 4) this.pickGesture.dragged = true;
            return false;
          }
          const handled = this.clippingHandles.pointerMove(event);
          if (handled && this.clippingHandles.dragging) {
            this.syncBoxFromHelper();
            this.emitClipValues(onClipValuesChanged);
          }
          canvas.style.cursor = this.clippingHandles.dragging ? 'grabbing' : this.clippingHandles.hovered ? 'grab' : '';
          return handled;
        },
        pointerLeave: () => { this.clippingHandles.pointerLeave(); this.clearCapture(); },
        wheel: () => { this.pickGesture = null; },
        pointerDown: event => {
          if (this.tools.isActive('coordinate-query') && (this.queryHovered || this.queryDragging)) return false;
          if (this.clippingHandles.pointerDown(event)) return true;
          if (!this.tools.isActive('coordinate-query') || !this.queryPicking || !onPick || event.button !== 0) return false;
          this.pickGesture = { x: event.clientX, y: event.clientY, dragged: false };
          return false;
        },
        pointerUp: event => {
          const gesture = this.pickGesture;
          this.pickGesture = null;
          if (gesture && !gesture.dragged && event.button === 0 && this.queryPicking
            && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) {
            const rect = canvas.getBoundingClientRect();
            const x = event.clientX - rect.left; const y = event.clientY - rect.top;
            const point = this.captureAt(x, y) ?? this.freeQueryPoint(x, y);
            this.setQueryPoint(point); onPick?.(point); this.setQueryPicking(false);
          }
          const handled = this.clippingHandles.pointerUp(event);
          if (handled) {
            this.syncBoxFromHelper();
            this.emitClipValues(onClipValuesChanged);
          }
          return handled;
        },
        navigationBlocked: event => event.button === 2 || this.gizmoTransforming
          || this.queryDragging || (event.button === 0 && this.queryHovered)
          || (event.button === 0 && this.clipGizmoInput.hovered),
        dragBlocked: () => this.clippingHandles.dragging || this.gizmoTransforming || this.queryDragging,
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
    if (!enabled) this.setQueryPicking(false);
    this.tools.activate(enabled ? 'coordinate-query' : this.axisClip.enabled || this.boxClip.enabled ? 'clipping' : 'idle');
    this.syncClipGizmos();
  }
  setQueryPicking(picking: boolean): void {
    this.queryPicking = picking && this.tools.isActive('coordinate-query');
    this.onPickingChanged?.(this.queryPicking);
    this.clearCapture();
    (this.application.app.graphicsDevice.canvas as HTMLCanvasElement).style.cursor = this.queryPicking ? 'crosshair' : '';
    this.syncQueryGizmo();
  }
  private clearCapture(): void {
    this.pickGesture = null;
    this.capturePointer = null; this.captureDirty = false; this.captureCamera = '';
    this.onCapture?.(null);
  }
  private freeQueryPoint(x: number, y: number): XYZ {
    const camera = this.application.camera;
    const component = camera.camera!;
    const bounds = this.scene.bounds();
    const center = bounds.min.clone().add(bounds.max).mulScalar(0.5);
    const reference = this.queryPoint ? this.queryAnchor.getPosition().clone() : center;
    if (reference.clone().sub(camera.getPosition()).dot(camera.forward) <= component.nearClip) reference.copy(center);
    const near = component.screenToWorld(x, y, component.nearClip);
    const direction = component.screenToWorld(x, y, component.farClip).sub(near);
    const distance = reference.sub(near).dot(camera.forward) / direction.dot(camera.forward);
    const point = near.add(direction.mulScalar(distance));
    const origin = this.scene.displayOrigin;
    return [point.x + origin[0], point.y + origin[1], point.z + origin[2]];
  }
  private captureAt(x: number, y: number): XYZ | null {
    const point = this.scene.pickPoint(this.application.camera, x, y);
    if (!point) { this.onCapture?.(null); return null; }
    const origin = this.scene.displayOrigin;
    const screen = this.application.camera.camera!.worldToScreen(new pc.Vec3(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]));
    this.onCapture?.({ point, x: screen.x, y: screen.y });
    return point;
  }
  setQueryPoint(point: XYZ): void {
    if (!point.every(Number.isFinite)) return;
    this.queryPoint = [...point];
    if (!this.queryDragging) {
      const origin = this.scene.displayOrigin;
      this.queryAnchor.setPosition(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]);
    }
    this.syncQueryGizmo();
  }
  private syncQueryGizmo(): void {
    const show = this.tools.isActive('coordinate-query') && !this.queryPicking && this.queryPoint !== null;
    if (show === this.queryAttached) return;
    if (show) this.queryGizmo.attach(this.queryAnchor);
    else { this.queryGizmo.detach(); this.queryHovered = false; this.queryDragging = false; }
    this.queryAttached = show;
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
  setSceneAxesVisible(visible: boolean): void {
    this.sceneAxesVisible = visible;
    if (!visible) this.onSceneAxes?.([]);
  }
  setOriginPlane(plane: 'xoy' | 'xoz' | 'yoz', visible: boolean, side: number): void {
    this.scene.setOriginPlane(plane, visible);
    if (plane === 'yoz') this.originSides.x = side;
    else if (plane === 'xoz') this.originSides.y = side;
    else this.originSides.z = side;
    this.refreshClip();
  }
  private refreshClip(): void {
    this.captureDirty = true;
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
    this.syncQueryGizmo();
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
    if (this.sceneAxesVisible) {
      const origin = this.scene.displayOrigin;
      const start = new pc.Vec3(-origin[0], -origin[1], -origin[2]);
      const length = this.scene.baseDiagonal * 0.3;
      const labels: Array<{ text: string; x: number; y: number; color: string }> = [];
      const camera = this.application.camera;
      const canvas = this.application.app.graphicsDevice.canvas as HTMLCanvasElement;
      const label = (point: pc.Vec3, text: string, color: string) => {
        const screen = camera.camera!.worldToScreen(point);
        if (point.clone().sub(camera.getPosition()).dot(camera.forward) > 0 && screen.x >= 0 && screen.x <= canvas.clientWidth && screen.y >= 0 && screen.y <= canvas.clientHeight)
          labels.push({ text, x: screen.x, y: screen.y, color });
      };
      label(start, 'O（0，0，0）', '#edf5ff');
      for (const [axis, direction, color, css] of [
        ['X', new pc.Vec3(length, 0, 0), pc.Color.RED, '#ff7777'],
        ['Y', new pc.Vec3(0, length, 0), pc.Color.GREEN, '#78e6a2'],
        ['Z', new pc.Vec3(0, 0, length), pc.Color.BLUE, '#85a6ff'],
      ] as const) {
        const end = start.clone().add(direction);
        this.application.app.drawLine(start, end, color, false);
        label(end, `＋${axis}`, css);
      }
      this.onSceneAxes?.(labels);
    }
    if (this.queryPicking && this.capturePointer) {
      const camera = this.application.camera;
      const signature = `${camera.getWorldTransform().data.join(',')},${camera.camera!.orthoHeight},${camera.camera!.fov},${camera.camera!.aspectRatio}`;
      if (this.captureDirty || signature !== this.captureCamera) {
        this.captureAt(this.capturePointer.x, this.capturePointer.y);
        this.captureDirty = false; this.captureCamera = signature;
      }
    }
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
  northView(up: XYZ, north: XYZ): void {
    this.camera.setViewDirection(new pc.Vec3(...up), new pc.Vec3(...north));
    this.camera.setProjection(true);
  }
  destroy(): void {
    this.application.app.off('update', this.updateHelpers, this);
    this.clipGizmoInput.destroy(); this.clipTranslate.destroy(); this.clipRotate.destroy();
    this.queryGizmo.destroy(); this.queryAnchor.destroy();
    this.input.destroy(); this.clippingHandles.destroy(); this.tools.destroy(); this.clipBox.destroy();
    this.gaussian.destroy(); this.scene.destroy(); this.application.destroy();
  }
}
