import * as pc from 'playcanvas';
type CameraVector = { x: number; y: number; z: number };
export interface CameraOrientation { right: CameraVector; cubeUp: CameraVector; direction: CameraVector }

export interface ViewportBounds {
  min: pc.Vec3;
  max: pc.Vec3;
}

export interface ViewportInputDelegate {
  navigationMode?(): 'orbit' | 'fly';
  orbitEnabled?(): boolean;
  pointerMove?(event: PointerEvent): boolean;
  pointerLeave?(): void;
  pointerDown?(event: PointerEvent): boolean;
  pointerUp?(event: PointerEvent): void;
  wheel?(event: WheelEvent): void;
  navigationBlocked?(event: PointerEvent): boolean;
  dragBlocked?(): boolean;
}

interface ViewportCameraOptions {
  camera: pc.Entity;
  canvas: HTMLCanvasElement;
  orientationChanged: (orientation: CameraOrientation) => void;
  baseDiagonal: number;
  getBounds: () => ViewportBounds;
}

export class ViewportCameraController {
  private readonly camera: pc.Entity;
  private readonly canvas: HTMLCanvasElement;
  private readonly orientationChanged: (orientation: CameraOrientation) => void;
  private readonly baseDiagonal: number;
  private readonly getBounds: () => ViewportBounds;
  private readonly target = new pc.Vec3();
  private readonly direction = new pc.Vec3();
  private readonly up = new pc.Vec3(0, 0, 1);
  private readonly zUp = new pc.Vec3(0, 0, 1);
  private distance = 1;
  private orthoHeight = 1;

  constructor(options: ViewportCameraOptions) {
    this.camera = options.camera;
    this.canvas = options.canvas;
    this.orientationChanged = options.orientationChanged;
    this.baseDiagonal = options.baseDiagonal;
    this.getBounds = options.getBounds;
    this.fit();
  }

  fit(): void {
    const { min, max } = this.getBounds();
    this.target.copy(min).add(max).mulScalar(0.5);
    const diagonal = max.clone().sub(min).length();
    this.distance = Math.max(diagonal * 1.2, 0.1);
    this.orthoHeight = Math.max(diagonal * 0.6, 0.05);
    this.camera.camera!.orthoHeight = this.orthoHeight;
    this.setDirectionFromAngles(135, 24);
    this.up.copy(this.zUp);
    this.update();
  }

  frame(bounds: ViewportBounds): void {
    const { min, max } = bounds;
    this.target.copy(min).add(max).mulScalar(0.5);
    const diagonal = Math.max(max.clone().sub(min).length(), 0.1);
    const aspect = Math.max(this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1), 0.1);
    this.orthoHeight = diagonal * 0.65 * Math.max(1, 1 / aspect);
    this.distance = diagonal * Math.max(1.2, 1.2 / aspect);
    this.camera.camera!.orthoHeight = this.orthoHeight;
    this.update();
  }

  resetToOrigin(): void {
    this.fit();
    this.target.set(0, 0, 0);
    this.update();
  }

  orbitByPixels(dx: number, dy: number): void {
    this.orbit(dx * 180 / Math.max(1, this.canvas.clientWidth), dy * 180 / Math.max(1, this.canvas.clientHeight));
  }

  orbit(horizontalDegrees: number, verticalDegrees: number): void {
    const d = this.direction;
    const horizontal = Math.hypot(d.x, d.y);
    // At a pole the screen's up vector determines the starting meridian.
    const yaw = horizontal > 1e-6 ? Math.atan2(d.x, d.y)
      : Math.atan2(-Math.sign(d.z) * this.up.x, -Math.sign(d.z) * this.up.y);
    const pitch = Math.atan2(d.z, horizontal) * 180 / Math.PI + verticalDegrees;
    this.setDirectionFromAngles(yaw * 180 / Math.PI + horizontalDegrees, Math.max(-89.9, Math.min(89.9, pitch)));
    this.up.copy(this.zUp);
    this.update();
  }

  moveByLocal(forward: number, right: number, vertical: number): void {
    const rightAxis = new pc.Vec3().cross(this.up, this.direction).normalize();
    this.target.add(this.direction.clone().mulScalar(-forward))
      .add(rightAxis.mulScalar(right)).add(this.zUp.clone().mulScalar(vertical));
    this.update();
  }

  panByPixels(dx: number, dy: number): void {
    const worldPerPixel = this.camera.camera!.projection === pc.PROJECTION_ORTHOGRAPHIC
      ? this.orthoHeight * 2 / Math.max(this.canvas.clientHeight, 1)
      : 2 * this.distance * Math.tan(this.camera.camera!.fov * Math.PI / 360) / Math.max(this.canvas.clientHeight, 1);
    const right = new pc.Vec3().cross(this.up, this.direction).normalize();
    this.target.add(right.mulScalar(-dx * worldPerPixel)).add(this.up.clone().mulScalar(dy * worldPerPixel));
    this.update();
  }

  zoom(deltaY: number): void {
    if (this.camera.camera!.projection === pc.PROJECTION_ORTHOGRAPHIC) {
      this.orthoHeight = Math.max(this.baseDiagonal * 0.001, this.orthoHeight * Math.exp(deltaY * 0.001));
      this.camera.camera!.orthoHeight = this.orthoHeight;
      return;
    }
    this.distance = Math.max(this.baseDiagonal * 0.001, this.distance * Math.exp(deltaY * 0.001));
    this.update();
  }

  setProjection(orthographic: boolean): void {
    this.camera.camera!.projection = orthographic ? pc.PROJECTION_ORTHOGRAPHIC : pc.PROJECTION_PERSPECTIVE;
    this.camera.camera!.orthoHeight = this.orthoHeight;
  }

  private update(): void {
    this.camera.setPosition(this.target.clone().add(this.direction.clone().mulScalar(this.distance)));
    this.camera.lookAt(this.target, this.up);
    const right = new pc.Vec3().cross(this.up, this.direction).normalize();
    const cubeUp = new pc.Vec3().cross(this.direction, right).normalize();
    this.orientationChanged({ right, cubeUp, direction: this.direction });
  }

  private setDirectionFromAngles(yawDegrees: number, pitchDegrees: number): void {
    const yaw = yawDegrees * Math.PI / 180;
    const pitch = pitchDegrees * Math.PI / 180;
    const horizontal = Math.cos(pitch);
    this.direction.set(horizontal * Math.sin(yaw), horizontal * Math.cos(yaw), Math.sin(pitch)).normalize();
  }

  setViewDirection(direction: pc.Vec3, up?: pc.Vec3): void {
    direction.normalize();
    this.direction.copy(direction);
    this.up.copy(up ?? (Math.abs(direction.z) > 0.999 ? pc.Vec3.UP : this.zUp));
    this.update();
  }
}
