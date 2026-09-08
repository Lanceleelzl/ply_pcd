import * as pc from 'playcanvas';

export type ClipAxis = 'x' | 'y' | 'z';
export type ClipSide = 'min' | 'max';

export interface AxisClipState {
  min: pc.Vec3;
  max: pc.Vec3;
  minEnabled: Record<ClipAxis, boolean>;
  maxEnabled: Record<ClipAxis, boolean>;
}

interface Handle {
  entity: pc.Entity;
  material: pc.StandardMaterial;
  label: HTMLSpanElement;
  axis: ClipAxis;
  side: ClipSide;
  kind: 'axis' | 'box';
  worldPosition: pc.Vec3;
}

interface DragState {
  handle: Handle;
  startX: number;
  startY: number;
  screenAxisX: number;
  screenAxisY: number;
  worldPerPixel: number;
  startValue: number;
  startCenter: pc.Vec3;
  startScale: pc.Vec3;
  worldAxis: pc.Vec3;
}

const axes: ClipAxis[] = ['x', 'y', 'z'];
const axisVector = (axis: ClipAxis) => axis === 'x' ? new pc.Vec3(1, 0, 0) : axis === 'y' ? new pc.Vec3(0, 1, 0) : new pc.Vec3(0, 0, 1);

export class ClippingHandles {
  hovered = false;
  dragging = false;

  private readonly handles: Handle[] = [];
  private readonly colors: Record<ClipAxis, pc.Color> = {
    x: new pc.Color(1, 0.24, 0.24), y: new pc.Color(0.18, 0.95, 0.42), z: new pc.Color(0.28, 0.42, 1),
  };
  private hoveredHandle: Handle | null = null;
  private drag: DragState | null = null;
  private readonly handleSize: number;
  private readonly axisPlanes: Record<ClipAxis, pc.Entity>;
  private revealedHandle: Handle | null = null;

  constructor(
    private readonly app: pc.Application,
    private readonly camera: pc.Entity,
    private readonly canvas: HTMLCanvasElement,
    private readonly getClipBox: () => pc.Entity,
    private readonly sceneMin: pc.Vec3,
    private readonly sceneMax: pc.Vec3,
    private readonly getMode: () => 'off' | 'axis' | 'box',
    private readonly getAxisState: () => AxisClipState,
    private readonly setAxisBoundary: (axis: ClipAxis, side: ClipSide, value: number) => void,
    private readonly helperVisible: () => boolean,
    private readonly onInteraction: (active: boolean) => void,
  ) {
    this.handleSize = Math.max(sceneMax.clone().sub(sceneMin).length() * 0.018, 0.08);
    this.axisPlanes = Object.fromEntries(axes.map(axis => {
      const material = new pc.StandardMaterial();
      material.diffuse = this.colors[axis]; material.emissive = this.colors[axis]; material.useLighting = false;
      material.opacity = 0.18; material.blendType = pc.BLEND_NORMAL; material.depthWrite = false; material.cull = pc.CULLFACE_NONE; material.update();
      const entity = new pc.Entity(`axis-clip-plane-${axis}`);
      entity.addComponent('render', { type: 'plane' });
      entity.render!.meshInstances.forEach(instance => { instance.material = material; });
      this.app.root.addChild(entity); entity.enabled = false;
      return [axis, entity];
    })) as Record<ClipAxis, pc.Entity>;
    for (const kind of ['axis', 'box'] as const) for (const axis of axes) for (const side of ['min', 'max'] as const) {
      const material = new pc.StandardMaterial();
      material.diffuse = this.colors[axis]; material.emissive = this.colors[axis]; material.useLighting = false;
      material.depthTest = false; material.blendType = pc.BLEND_NORMAL; material.opacity = kind === 'box' ? 0.55 : 0.9; material.update();
      const entity = new pc.Entity(`${kind}-${axis}-${side}`);
      if (kind === 'box') {
        const pad = new pc.Entity('face-pad'); pad.addComponent('render', { type: 'box' });
        pad.render!.meshInstances.forEach(instance => { instance.material = material; });
        pad.setLocalPosition(0, 0.02, 0); pad.setLocalScale(0.82, 0.08, 0.82); entity.addChild(pad);
      }
      const stem = new pc.Entity('stem'); stem.addComponent('render', { type: 'cylinder' });
      stem.render!.meshInstances.forEach(instance => { instance.material = material; });
      stem.setLocalPosition(0, 0.24, 0); stem.setLocalScale(0.14, 0.48, 0.14); entity.addChild(stem);
      const head = new pc.Entity('head'); head.addComponent('render', { type: 'cone' });
      head.render!.meshInstances.forEach(instance => { instance.material = material; });
      head.setLocalPosition(0, 0.62, 0); head.setLocalScale(0.42, 0.42, 0.42); entity.addChild(head);
      this.app.root.addChild(entity); entity.enabled = false;
      const label = document.createElement('span'); label.className = `clip-handle-label axis-${axis}`; label.textContent = `${side === 'min' ? '−' : '+'}${axis.toUpperCase()}`;
      this.canvas.parentElement!.appendChild(label);
      this.handles.push({ entity, material, label, axis, side, kind, worldPosition: new pc.Vec3() });
    }
  }

  update(): void {
    const mode = this.getMode();
    const show = mode !== 'off' && this.helperVisible();
    const center = this.sceneMin.clone().add(this.sceneMax).mulScalar(0.5);
    const state = this.getAxisState();
    const clipBox = this.getClipBox();
    const boxTransform = clipBox.getWorldTransform();
    for (const handle of this.handles) {
      if (handle.kind === 'axis') {
        handle.worldPosition.copy(center);
        const enabled = handle.side === 'min' ? state.minEnabled[handle.axis] : state.maxEnabled[handle.axis];
        const fallback = handle.side === 'min' ? this.sceneMin[handle.axis] : this.sceneMax[handle.axis];
        handle.worldPosition[handle.axis] = enabled ? state[handle.side][handle.axis] : fallback;
      } else {
        const local = axisVector(handle.axis).mulScalar(handle.side === 'min' ? -0.5 : 0.5);
        boxTransform.transformPoint(local, handle.worldPosition);
      }
      handle.entity.enabled = show && handle.kind === mode && (handle.kind === 'box'
        ? true
        : handle === this.revealedHandle || handle === this.drag?.handle);
      handle.label.hidden = !handle.entity.enabled;
      if (!handle.entity.enabled) continue;
      handle.entity.setPosition(handle.worldPosition);
      const hovered = handle === this.hoveredHandle || this.drag?.handle === handle;
      const scale = hovered ? 1.12 : 1;
      const direction = axisVector(handle.axis).mulScalar(handle.side === 'min' ? -1 : 1);
      if (handle.kind === 'box') {
        const boxScale = clipBox.getLocalScale();
        const shortestSide = Math.min(Math.abs(boxScale.x), Math.abs(boxScale.y), Math.abs(boxScale.z));
        const arrowSize = Math.min(this.handleSize * 0.9, Math.max(this.handleSize * 0.22, shortestSide * 0.13)) * scale;
        const worldDirection = clipBox.getRotation().transformVector(direction, new pc.Vec3()).normalize();
        handle.entity.setRotation(new pc.Quat().setFromDirections(pc.Vec3.UP, worldDirection));
        handle.entity.setLocalScale(arrowSize, arrowSize, arrowSize);
      } else {
        handle.entity.setRotation(new pc.Quat().setFromDirections(pc.Vec3.UP, direction));
        handle.entity.setLocalScale(this.handleSize * 1.35 * scale, this.handleSize * 1.35 * scale, this.handleSize * 1.35 * scale);
      }
      const opacity = handle.kind === 'box' ? (hovered ? 1 : 0.55) : (hovered ? 1 : 0.9);
      if (handle.material.opacity !== opacity) { handle.material.opacity = opacity; handle.material.update(); }
      const screen = this.camera.camera!.worldToScreen(handle.worldPosition); const rect = this.canvas.getBoundingClientRect();
      handle.label.hidden = handle.kind === 'box' && !hovered;
      handle.label.style.left = `${screen.x * rect.width / this.app.graphicsDevice.width}px`;
      handle.label.style.top = `${screen.y * rect.height / this.app.graphicsDevice.height}px`;
    }
    this.updateAxisPlanes(show && mode === 'axis');
    if (!show) return;
    if (mode === 'axis') this.drawAxisHelpers(center);
  }

  pointerMove(event: PointerEvent): boolean {
    const point = this.pointerPosition(event);
    if (this.drag) {
      const dx = point.x - this.drag.startX; const dy = point.y - this.drag.startY;
      const delta = (dx * this.drag.screenAxisX + dy * this.drag.screenAxisY) * this.drag.worldPerPixel;
      if (this.drag.handle.kind === 'axis') {
        this.setAxisBoundary(this.drag.handle.axis, this.drag.handle.side, this.drag.startValue + delta);
      } else {
        const sign = this.drag.handle.side === 'max' ? 1 : -1;
        const startSize = this.drag.startScale[this.drag.handle.axis];
        const nextSize = Math.max(0.001, startSize + sign * delta);
        const appliedDelta = (nextSize - startSize) * sign;
        const nextScale = this.drag.startScale.clone(); nextScale[this.drag.handle.axis] = nextSize;
        const clipBox = this.getClipBox();
        clipBox.setLocalScale(nextScale);
        clipBox.setPosition(this.drag.startCenter.clone().add(this.drag.worldAxis.clone().mulScalar(appliedDelta * 0.5)));
      }
      return true;
    }
    const mode = this.getMode();
    if (mode === 'axis') {
      this.hoveredHandle = this.pick(point.x, point.y);
      this.revealedHandle = this.axisHoverTarget(point.x, point.y) ?? this.hoveredHandle;
      this.hovered = Boolean(this.hoveredHandle);
      return this.hovered;
    }
    this.hoveredHandle = this.pick(point.x, point.y);
    if (mode === 'box') {
      this.hovered = Boolean(this.hoveredHandle);
      return this.hovered;
    }
    this.revealedHandle = null;
    this.hovered = Boolean(this.hoveredHandle);
    return this.hovered;
  }

  pointerLeave(): void {
    if (this.drag) return;
    this.revealedHandle = null; this.hoveredHandle = null; this.hovered = false;
  }

  pointerDown(event: PointerEvent): boolean {
    if (event.button !== 0) return false;
    const point = this.pointerPosition(event); const handle = this.pick(point.x, point.y);
    if (!handle) return false;
    const worldAxis = handle.kind === 'axis'
      ? axisVector(handle.axis)
      : this.getClipBox().getRotation().transformVector(axisVector(handle.axis), new pc.Vec3()).normalize();
    const referenceLength = Math.max(this.sceneMax.clone().sub(this.sceneMin).length() * 0.25, 0.1);
    const startScreen = this.camera.camera!.worldToScreen(handle.worldPosition);
    const axisScreen = this.camera.camera!.worldToScreen(handle.worldPosition.clone().add(worldAxis.clone().mulScalar(referenceLength)));
    let screenX = axisScreen.x - startScreen.x; let screenY = axisScreen.y - startScreen.y;
    let pixels = Math.hypot(screenX, screenY);
    if (pixels < 2) { screenX = 0; screenY = -1; pixels = 1; }
    this.drag = {
      handle, startX: point.x, startY: point.y, screenAxisX: screenX / pixels, screenAxisY: screenY / pixels,
      worldPerPixel: referenceLength / pixels,
      startValue: this.getAxisState()[handle.side][handle.axis], startCenter: this.getClipBox().getPosition().clone(),
      startScale: this.getClipBox().getLocalScale().clone(), worldAxis,
    };
    this.dragging = true; this.onInteraction(true); this.canvas.setPointerCapture(event.pointerId);
    return true;
  }

  pointerUp(event: PointerEvent): boolean {
    if (!this.drag) return false;
    this.drag = null; this.dragging = false; this.onInteraction(false);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    return true;
  }

  isBoxPresentationVisible(): boolean {
    return this.getMode() === 'box' && this.helperVisible();
  }

  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.app.graphicsDevice.width / rect.width,
      y: (event.clientY - rect.top) * this.app.graphicsDevice.height / rect.height,
    };
  }

  private pick(x: number, y: number): Handle | null {
    let best: Handle | null = null; let bestDistance = Number.POSITIVE_INFINITY;
    for (const handle of this.handles) {
      if (!handle.entity.enabled) continue;
      const base = this.camera.camera!.worldToScreen(handle.worldPosition);
      const worldDirection = handle.entity.getRotation().transformVector(pc.Vec3.UP, new pc.Vec3()).normalize();
      const tipWorld = handle.worldPosition.clone().add(worldDirection.mulScalar(handle.entity.getLocalScale().y * 0.86));
      const tip = this.camera.camera!.worldToScreen(tipWorld);
      const dx = tip.x - base.x; const dy = tip.y - base.y; const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((x - base.x) * dx + (y - base.y) * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(x - (base.x + dx * t), y - (base.y + dy * t));
      const tolerance = 14 * window.devicePixelRatio;
      if (distance < tolerance && distance < bestDistance) { best = handle; bestDistance = distance; }
    }
    return best;
  }

  private axisHoverTarget(x: number, y: number): Handle | null {
    const center = this.sceneMin.clone().add(this.sceneMax).mulScalar(0.5);
    const centerScreen = this.camera.camera!.worldToScreen(center);
    const diagonal = this.sceneMax.clone().sub(this.sceneMin).length();
    let best: Handle | null = null; let bestDistance = 18 * window.devicePixelRatio;
    for (const handle of this.handles) {
      if (handle.kind !== 'axis') continue;
      const direction = axisVector(handle.axis).mulScalar(handle.side === 'min' ? -1 : 1);
      const reference = center.clone().add(direction.mulScalar(Math.max(diagonal * 0.08, 0.1)));
      const referenceScreen = this.camera.camera!.worldToScreen(reference);
      const dx = referenceScreen.x - centerScreen.x; const dy = referenceScreen.y - centerScreen.y;
      const length = Math.hypot(dx, dy); if (length < 4 * window.devicePixelRatio) continue;
      const unitX = dx / length; const unitY = dy / length;
      const fromCenterX = x - centerScreen.x; const fromCenterY = y - centerScreen.y;
      const along = fromCenterX * unitX + fromCenterY * unitY;
      if (along < 3 * window.devicePixelRatio) continue;
      const distance = Math.abs(fromCenterX * unitY - fromCenterY * unitX);
      if (distance < bestDistance) { best = handle; bestDistance = distance; }
    }
    return best;
  }

  private drawAxisHelpers(center: pc.Vec3): void {
    const diagonal = this.sceneMax.clone().sub(this.sceneMin).length();
    for (const axis of axes) {
      const direction = axisVector(axis); const color = this.colors[axis];
      this.app.drawLine(center.clone().sub(direction.clone().mulScalar(diagonal)), center.clone().add(direction.clone().mulScalar(diagonal)), color, false);
    }
  }

  private updateAxisPlanes(show: boolean): void {
    const activeHandle = this.drag?.handle.kind === 'axis' ? this.drag.handle : null;
    const center = this.sceneMin.clone().add(this.sceneMax).mulScalar(0.5);
    const size = this.sceneMax.clone().sub(this.sceneMin);
    for (const axis of axes) {
      const plane = this.axisPlanes[axis];
      plane.enabled = show && activeHandle?.axis === axis;
      if (!plane.enabled || !activeHandle) continue;
      const value = this.getAxisState()[activeHandle.side][axis];
      const position = center.clone(); position[axis] = value; plane.setPosition(position);
      if (axis === 'x') { plane.setEulerAngles(0, 0, 90); plane.setLocalScale(size.y, 1, size.z); }
      else if (axis === 'y') { plane.setEulerAngles(0, 0, 0); plane.setLocalScale(size.x, 1, size.z); }
      else { plane.setEulerAngles(90, 0, 0); plane.setLocalScale(size.x, 1, size.y); }
    }
  }
}
