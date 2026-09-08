import * as pc from 'playcanvas';
import { createCubeLabels } from '../../cube-labels';

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
  root: HTMLElement;
  baseDiagonal: number;
  getBounds: () => ViewportBounds;
}

export class ViewportCameraController {
  private readonly camera: pc.Entity;
  private readonly canvas: HTMLCanvasElement;
  private readonly root: HTMLElement;
  private readonly baseDiagonal: number;
  private readonly getBounds: () => ViewportBounds;
  private readonly events = new AbortController();
  private readonly target = new pc.Vec3();
  private readonly direction = new pc.Vec3();
  private readonly up = new pc.Vec3(0, 0, 1);
  private readonly zUp = new pc.Vec3(0, 0, 1);
  private distance = 1;
  private orthoHeight = 1;

  constructor(options: ViewportCameraOptions) {
    this.camera = options.camera;
    this.canvas = options.canvas;
    this.root = options.root;
    this.baseDiagonal = options.baseDiagonal;
    this.getBounds = options.getBounds;
    this.bindViewControls();
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

  destroy(): void {
    this.events.abort();
  }

  private bindViewControls(): void {
    const signal = this.events.signal;
    const viewCube = this.root.querySelector<HTMLElement>('.view-cube')!;
    const updateCubeLabels = createCubeLabels(viewCube);
    const corners = Array.from(this.root.querySelectorAll<HTMLElement>('.cube-corner'));
    let cubeDragging = false;
    let cubeDragMoved = false;
    let cubeDragDistance = 0;
    let cubeDragAxis: 'horizontal' | 'vertical' | 'free' | null = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;

    this.update = () => {
      this.camera.setPosition(this.target.clone().add(this.direction.clone().mulScalar(this.distance)));
      this.camera.lookAt(this.target, this.up);
      const right = new pc.Vec3().cross(this.up, this.direction).normalize();
      const cubeUp = new pc.Vec3().cross(this.direction, right).normalize();
      viewCube.style.transform = `matrix3d(${right.x},${-cubeUp.x},${this.direction.x},0,${-right.y},${cubeUp.y},${-this.direction.y},0,${right.z},${-cubeUp.z},${this.direction.z},0,0,0,0,1)`;
      updateCubeLabels();
      const inverse = `matrix3d(${right.x},${-right.y},${right.z},0,${-cubeUp.x},${cubeUp.y},${-cubeUp.z},0,${this.direction.x},${-this.direction.y},${this.direction.z},0,0,0,0,1)`;
      corners.forEach(corner => {
        const [x, y, z] = corner.dataset.direction!.split(',').map(Number);
        corner.style.transform = `translate3d(${x * 30}px, ${y * -30}px, ${z * 30}px) ${inverse}`;
      });
    };

    this.root.querySelectorAll<HTMLButtonElement>('.view-cube button[data-direction]').forEach(button => {
      button.addEventListener('click', () => {
        const [x, y, z] = button.dataset.direction!.split(',').map(Number);
        this.setViewDirection(new pc.Vec3(x, y, z));
      }, { signal });
    });
    const scene = this.root.querySelector<HTMLElement>('.view-cube-scene')!;
    scene.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      cubeDragging = true;
      cubeDragMoved = false;
      cubeDragDistance = 0;
      cubeDragAxis = null;
      startX = lastX = event.clientX;
      startY = lastY = event.clientY;
    }, { signal });
    scene.addEventListener('pointermove', event => {
      if (!cubeDragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      cubeDragDistance += Math.hypot(dx, dy);
      if (cubeDragDistance > 5 && !cubeDragMoved) {
        cubeDragMoved = true;
        const totalX = event.clientX - startX;
        const totalY = event.clientY - startY;
        cubeDragAxis = Math.abs(totalY) > Math.abs(totalX) * 1.5 ? 'vertical'
          : Math.abs(totalX) > Math.abs(totalY) * 1.5 ? 'horizontal' : 'free';
        scene.setPointerCapture(event.pointerId);
        scene.classList.add('dragging');
      }
      if (cubeDragMoved) this.orbit((cubeDragAxis === 'vertical' ? 0 : dx) * 0.6, (cubeDragAxis === 'horizontal' ? 0 : dy) * 0.6);
    }, { signal });
    scene.addEventListener('pointerup', event => {
      cubeDragging = false;
      scene.classList.remove('dragging');
      if (scene.hasPointerCapture(event.pointerId)) scene.releasePointerCapture(event.pointerId);
    }, { signal });
    scene.addEventListener('pointercancel', () => {
      cubeDragging = false;
      scene.classList.remove('dragging');
    }, { signal });
    scene.addEventListener('click', event => {
      if (!cubeDragMoved) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cubeDragMoved = false;
    }, { capture: true, signal });
    this.root.querySelectorAll<HTMLButtonElement>('.projection-switch button').forEach(button => {
      button.addEventListener('click', () => {
        const orthographic = button.dataset.projection === 'orthographic';
        this.camera.camera!.projection = orthographic ? pc.PROJECTION_ORTHOGRAPHIC : pc.PROJECTION_PERSPECTIVE;
        this.camera.camera!.orthoHeight = this.orthoHeight;
        this.root.querySelectorAll('.projection-switch button').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
      }, { signal });
    });
  }

  private update(): void {}

  private setDirectionFromAngles(yawDegrees: number, pitchDegrees: number): void {
    const yaw = yawDegrees * Math.PI / 180;
    const pitch = pitchDegrees * Math.PI / 180;
    const horizontal = Math.cos(pitch);
    this.direction.set(horizontal * Math.sin(yaw), horizontal * Math.cos(yaw), Math.sin(pitch)).normalize();
  }

  private setViewDirection(direction: pc.Vec3): void {
    direction.normalize();
    this.direction.copy(direction);
    this.up.copy(Math.abs(direction.z) > 0.999 ? pc.Vec3.UP : this.zUp);
    this.update();
  }

  private orbit(horizontalDegrees: number, verticalDegrees: number): void {
    const yaw = new pc.Quat().setFromAxisAngle(this.up, -horizontalDegrees);
    yaw.transformVector(this.direction, this.direction).normalize();
    const right = new pc.Vec3().cross(this.up, this.direction).normalize();
    const pitch = new pc.Quat().setFromAxisAngle(right, -verticalDegrees);
    pitch.transformVector(this.direction, this.direction).normalize();
    pitch.transformVector(this.up, this.up).normalize();
    this.update();
  }
}
