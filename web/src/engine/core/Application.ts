import * as pc from 'playcanvas';
import { ResourceScope } from '../../app/resource-scope';

interface RegistrationApplicationOptions {
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  clearColor?: pc.Color;
}

export class RegistrationApplication {
  readonly app: pc.Application;
  readonly camera: pc.Entity;

  private readonly resources = new ResourceScope();

  constructor(options: RegistrationApplicationOptions) {
    try {
      const keyboard = new pc.Keyboard(window);
      this.resources.add(() => keyboard.detach());
      const mouse = new pc.Mouse(options.canvas);
      this.resources.add(() => mouse.detach());
      const touch = new pc.TouchDevice(options.canvas);
      this.resources.add(() => touch.detach());
      this.app = new pc.Application(options.canvas, { mouse, touch, keyboard });
      this.resources.add(() => this.app.destroy());
      this.app.setCanvasFillMode(pc.FILLMODE_NONE, options.viewport.clientWidth, options.viewport.clientHeight);
      this.app.setCanvasResolution(pc.RESOLUTION_AUTO);
      this.app.scene.gsplat.alphaClip = 0.1;

      this.camera = new pc.Entity('Camera');
      this.camera.addComponent('camera', {
        clearColor: options.clearColor ?? new pc.Color(0.035, 0.055, 0.085),
        farClip: 100000,
        toneMapping: pc.TONEMAP_ACES,
      });
      this.app.root.addChild(this.camera);

      const resizeObserver = new ResizeObserver(() => {
        this.app.resizeCanvas(options.viewport.clientWidth, options.viewport.clientHeight);
      });
      this.resources.add(() => resizeObserver.disconnect());
      resizeObserver.observe(options.viewport);
      this.app.start();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  destroy(): void {
    this.resources.dispose();
  }
}
