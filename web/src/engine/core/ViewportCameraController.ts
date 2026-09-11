import * as pc from 'playcanvas';
type CameraVector = { x: number; y: number; z: number };
export interface CameraOrientation { right: CameraVector; cubeUp: CameraVector; direction: CameraVector }

export interface ViewportBounds {
  min: pc.Vec3;
  max: pc.Vec3;
}

export interface ViewportInputDelegate {
  pointerMove?(event: PointerEvent): boolean;
  pointerLeave?(): void;
  pointerDown?(event: PointerEvent): boolean;
  pointerUp?(event: PointerEvent): void;
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

  orbitByPixels(dx: number, dy: number): void {
    this.orbit(dx * 180 / Math.max(1, this.canvas.clientWidth), dy * 180 / Math.max(1, this.canvas.clientHeight));
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

  setViewDirection(direction: pc.Vec3): void {
    direction.normalize();
    this.direction.copy(direction);
    this.up.copy(Math.abs(direction.z) > 0.999 ? pc.Vec3.UP : this.zUp);
    this.update();
  }

  orbit(horizontalDegrees: number, verticalDegrees: number): void {
    const yaw = new pc.Quat().setFromAxisAngle(this.up, -horizontalDegrees);
    yaw.transformVector(this.direction, this.direction).normalize();
    const right = new pc.Vec3().cross(this.up, this.direction).normalize();
    const pitch = new pc.Quat().setFromAxisAngle(right, -verticalDegrees);
    pitch.transformVector(this.direction, this.direction).normalize();
    pitch.transformVector(this.up, this.up).normalize();
    this.update();
  }
}
