import * as pc from 'playcanvas';

interface RegistrationApplicationOptions {
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  clearColor?: pc.Color;
}

export class RegistrationApplication {
  readonly app: pc.Application;
  readonly camera: pc.Entity;

  private readonly resizeObserver: ResizeObserver;
  private destroyed = false;

  constructor(options: RegistrationApplicationOptions) {
    const keyboard = new pc.Keyboard(window);
    this.app = new pc.Application(options.canvas, {
      mouse: new pc.Mouse(options.canvas),
      touch: new pc.TouchDevice(options.canvas),
      keyboard,
    });
    this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
    this.app.scene.gsplat.alphaClip = 0.1;

    this.camera = new pc.Entity('Camera');
    this.camera.addComponent('camera', {
      clearColor: options.clearColor ?? new pc.Color(0.035, 0.055, 0.085),
      farClip: 100000,
      toneMapping: pc.TONEMAP_ACES,
    });
    this.app.root.addChild(this.camera);

    this.resizeObserver = new ResizeObserver(() => {
      this.app.resizeCanvas(options.viewport.clientWidth, options.viewport.clientHeight);
    });
    this.resizeObserver.observe(options.viewport);
    this.app.start();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.app.destroy();
  }
}
