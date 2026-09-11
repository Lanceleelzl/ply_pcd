import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import type { TransformParameters, XYZ } from '../../coordinate-math';
import type { PreviewCloud } from '../../point-cloud';
import { ResourceScope } from '../../app/resource-scope';
import { RegistrationApplication } from './Application';
import { RegistrationScene } from '../modules/RegistrationScene';
import { ViewportCameraController, type ViewportInputDelegate } from './ViewportCameraController';
import { InputController } from './InputController';
import { ToolManager } from './ToolManager';

export type EditingToolId = 'idle' | 'model-transform' | 'clipping' | 'coordinate-query';

interface RegistrationEngineOptions {
  canvas: HTMLCanvasElement;
  root: HTMLElement;
  clouds: Record<ModelId, PreviewCloud>;
  origins: Record<ModelId, XYZ>;
  transforms: Record<ModelId, TransformParameters>;
  moving: ModelId;
}

export class RegistrationEngine {
  readonly app: pc.Application;
  readonly camera: pc.Entity;
  readonly scene: RegistrationScene;
  readonly cameraController: ViewportCameraController;
  readonly translate: pc.TranslateGizmo;
  readonly rotate: pc.RotateGizmo;
  readonly clipTranslate: pc.TranslateGizmo;
  readonly clipRotate: pc.RotateGizmo;
  readonly tools = new ToolManager<EditingToolId>();
  private readonly resources = new ResourceScope();
  private input: InputController | null = null;

  constructor(private readonly options: RegistrationEngineOptions) {
    try {
      const application = new RegistrationApplication({ canvas: options.canvas, viewport: options.canvas.parentElement! });
      this.resources.add(() => application.destroy());
      this.app = application.app;
      this.camera = application.camera;
      this.scene = new RegistrationScene(this.app, options.clouds, options.origins, options.transforms, options.moving);
      this.resources.add(() => this.scene.destroy());
      this.cameraController = new ViewportCameraController({
        camera: this.camera, canvas: options.canvas, root: options.root,
        baseDiagonal: this.scene.baseDiagonal, getBounds: () => this.scene.bounds(),
      });
      this.resources.add(() => this.cameraController.destroy());
      const translate = (name: string) => {
        const gizmo = new pc.TranslateGizmo(this.camera.camera!, pc.TranslateGizmo.createLayer(this.app, name));
        this.resources.add(() => gizmo.destroy());
        gizmo.axisGap = 0.08; gizmo.axisLineLength = 0.72; gizmo.axisPlaneSize = 0.14; gizmo.axisPlaneGap = 0.22;
        return gizmo;
      };
      const rotate = (name: string) => {
        const gizmo = new pc.RotateGizmo(this.camera.camera!, pc.RotateGizmo.createLayer(this.app, name));
        this.resources.add(() => gizmo.destroy());
        gizmo.centerRadius = 0.001; gizmo.ringTolerance = 0.025;
        return gizmo;
      };
      this.translate = translate('Moving Model Translation');
      this.rotate = rotate('Moving Model Rotation');
      this.clipTranslate = translate('Clipping Box Translation');
      this.clipRotate = rotate('Clipping Box Rotation');
      this.resources.add(() => this.tools.destroy());
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  bindInput(delegate: ViewportInputDelegate): void {
    if (this.input) throw new Error('Viewport input is already bound');
    this.input = new InputController(this.options.canvas, this.cameraController, delegate);
    this.resources.add(() => this.input?.destroy());
  }

  destroy(): void { this.resources.dispose(); }
}
