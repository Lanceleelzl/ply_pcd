/** Camera navigation independent of the scene renderer and model format. */
export interface SceneNavigationCamera {
  move(forward: number, right: number, up: number): void;
  look(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  dolly(delta: number): void;
}

export interface SceneNavigationOptions {
  camera: SceneNavigationCamera;
  canvas: HTMLCanvasElement;
  speed: () => number;
  blocked?: () => boolean;
  frame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

export function navigationVector(keys: ReadonlySet<string>, speed: number, elapsedSeconds: number): [number, number, number] {
  const forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
  const right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
  const up = Number(keys.has('KeyE')) - Number(keys.has('KeyQ'));
  const magnitude = Math.hypot(forward, right, up);
  if (!magnitude) return [0, 0, 0];
  const distance = speed * Math.min(Math.max(elapsedSeconds, 0), 0.1) / magnitude;
  return [forward * distance, right * distance, up * distance];
}

export class SceneNavigationController {
  private readonly events = new AbortController();
  private readonly keys = new Set<string>();
  private readonly frame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private frameHandle = 0;
  private lastFrame = 0;
  private dragging: 'look' | 'pan' | null = null;
  private pointer = { x: 0, y: 0 };

  constructor(private readonly options: SceneNavigationOptions) {
    const { canvas } = options;
    const { signal } = this.events;
    this.frame = options.frame ?? requestAnimationFrame;
    this.cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
    canvas.tabIndex = canvas.tabIndex < 0 ? 0 : canvas.tabIndex;
    canvas.addEventListener('keydown', event => {
      if (!/^Key[WASDQE]$/.test(event.code) && event.code !== 'ShiftLeft' && event.code !== 'ShiftRight') return;
      if (this.blocked()) return;
      this.keys.add(event.code);
      event.preventDefault();
    }, { signal });
    canvas.addEventListener('keyup', event => { this.keys.delete(event.code); }, { signal });
    canvas.addEventListener('blur', () => this.clear(), { signal });
    window.addEventListener('blur', () => this.clear(), { signal });
    canvas.addEventListener('pointerdown', event => {
      if (this.blocked() || (event.button !== 0 && event.button !== 1)) return;
      canvas.focus();
      this.dragging = event.button === 1 ? 'pan' : 'look';
      this.pointer = { x: event.clientX, y: event.clientY };
      if (event.button === 1) event.preventDefault();
    }, { signal });
    window.addEventListener('pointermove', event => {
      if (!this.dragging || this.blocked()) return;
      const dx = event.clientX - this.pointer.x;
      const dy = event.clientY - this.pointer.y;
      this.pointer = { x: event.clientX, y: event.clientY };
      if (this.dragging === 'look') options.camera.look(dx, dy);
      else options.camera.pan(dx, dy);
    }, { signal });
    window.addEventListener('pointerup', () => { this.dragging = null; }, { signal });
    canvas.addEventListener('wheel', event => {
      if (this.blocked()) return;
      event.preventDefault();
      options.camera.dolly(event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1));
    }, { passive: false, signal });
    canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal });
    this.frameHandle = this.frame(this.tick);
  }

  clear(): void { this.keys.clear(); this.dragging = null; }

  destroy(): void {
    this.events.abort();
    this.cancelFrame(this.frameHandle);
    this.clear();
  }

  private blocked(): boolean {
    return this.options.blocked?.() ?? false;
  }

  private readonly tick = (time: number): void => {
    const elapsed = this.lastFrame ? (time - this.lastFrame) / 1000 : 0;
    this.lastFrame = time;
    if (this.blocked()) this.keys.clear();
    else if (this.options.canvas === document.activeElement) {
      const multiplier = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 5 : 1;
      const [forward, right, up] = navigationVector(this.keys, this.options.speed() * multiplier, elapsed);
      if (forward || right || up) this.options.camera.move(forward, right, up);
    }
    this.frameHandle = this.frame(this.tick);
  };
}
