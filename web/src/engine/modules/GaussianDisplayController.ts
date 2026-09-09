import * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
import { GaussianClipController } from '../../gaussian-clipping';

interface GaussianDisplayOptions {
  app: pc.Application;
  root: HTMLElement;
  entities: Record<ModelId, pc.Entity>;
  urls: Record<ModelId, string | undefined>;
  bytes: Record<ModelId, number | undefined>;
  origins: Record<ModelId, XYZ>;
  clippingEnabled(): boolean;
  clipStateChanged(): void;
  presentationChanged(): void;
}

interface GaussianDisplay {
  entity: pc.Entity | null;
  asset: pc.Asset | null;
  clipController: GaussianClipController | null;
  active: boolean;
  loading: boolean;
}

const models: ModelId[] = ['a', 'b'];
const formatBytes = (bytes?: number) => bytes
  ? `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`
  : '大小未知';

export class GaussianDisplayController {
  private readonly events = new AbortController();
  private readonly buttons: Record<ModelId, HTMLButtonElement>;
  private readonly status: HTMLElement;
  private readonly displays: Record<ModelId, GaussianDisplay> = {
    a: { entity: null, asset: null, clipController: null, active: false, loading: false },
    b: { entity: null, asset: null, clipController: null, active: false, loading: false },
  };
  private destroyed = false;

  constructor(private readonly options: GaussianDisplayOptions) {
    this.buttons = {
      a: options.root.querySelector<HTMLButtonElement>('#gaussian-model-a')!,
      b: options.root.querySelector<HTMLButtonElement>('#gaussian-model-b')!,
    };
    this.status = options.root.querySelector<HTMLElement>('#gaussian-status')!;
    models.forEach(model => {
      const button = this.buttons[model];
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => void this.toggle(model), { signal: this.events.signal });
    });
  }

  refreshStatus(error?: string): void {
    const activeModels = models.filter(model => this.displays[model].active);
    if (error) {
      this.status.hidden = false;
      this.status.classList.add('error');
      this.status.textContent = error;
      return;
    }
    this.status.classList.remove('error');
    if (activeModels.length === 0) {
      this.status.hidden = true;
      this.status.textContent = '';
      return;
    }
    this.status.hidden = false;
    const names = activeModels.map(model => model.toUpperCase()).join('、');
    this.status.textContent = this.options.clippingEnabled()
      ? `模型 ${names} 正在显示完整 Gaussian，并与当前剖切范围同步；剖切仅影响视觉预览。`
      : `模型 ${names} 正在显示完整 Gaussian；该模式仅用于视觉确认，不改变 ICP 输入。`;
  }

  setClipState(
    model: ModelId,
    enabled: boolean,
    min: pc.Vec3,
    max: pc.Vec3,
    boxEnabled: boolean,
    worldToBox: pc.Mat4,
    originSides: pc.Vec3,
    worldToOrigin: pc.Mat4,
    force = false,
  ): void {
    this.displays[model].clipController?.setClipState(
      enabled, min, max, boxEnabled, worldToBox, originSides, worldToOrigin, force,
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events.abort();
    models.forEach(model => this.release(model));
  }

  private async toggle(model: ModelId): Promise<void> {
    const url = this.options.urls[model];
    const display = this.displays[model];
    const button = this.buttons[model];
    if (!url || display.loading || this.destroyed) return;
    display.loading = true;
    button.disabled = true;
    try {
      if (display.active) {
        this.release(model);
        this.refreshStatus();
        this.options.presentationChanged();
        return;
      }
      button.textContent = `${model.toUpperCase()}：高斯`;
      button.title = '正在加载原始 Gaussian…';
      const asset = new pc.Asset(`Model ${model.toUpperCase()} Original Gaussian PLY`, 'gsplat', {
        url,
        filename: `model-${model}-original-gaussian.ply`,
      });
      display.asset = asset;
      this.options.app.assets.add(asset);
      await new Promise<void>((resolve, reject) => {
        asset.ready(() => resolve());
        asset.once('error', reject);
        this.options.app.assets.load(asset);
      });
      if (this.destroyed) return;
      const entity = new pc.Entity(`Model ${model.toUpperCase()} Original Gaussian`);
      entity.addComponent('gsplat', { asset });
      const origin = this.options.origins[model];
      entity.setLocalPosition(-origin[0], -origin[1], -origin[2]);
      this.options.entities[model].addChild(entity);
      display.entity = entity;
      display.clipController = new GaussianClipController(entity.gsplat!);
      display.active = true;
      this.options.entities[model].render!.enabled = false;
      button.textContent = `${model.toUpperCase()}：点云`;
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      button.title = `释放模型 ${model.toUpperCase()} Gaussian 并显示中心点`;
      this.options.clipStateChanged();
      this.refreshStatus();
      this.options.presentationChanged();
    } catch (error) {
      this.release(model);
      if (!this.destroyed) {
        this.refreshStatus(`模型 ${model.toUpperCase()} Gaussian 加载失败，已保留中心点：${String(error)}`);
        console.error(error);
      }
    } finally {
      display.loading = false;
      if (!this.destroyed) button.disabled = false;
    }
  }

  private release(model: ModelId): void {
    const display = this.displays[model];
    display.clipController = null;
    display.entity?.destroy();
    if (display.asset) {
      display.asset.unload();
      this.options.app.assets.remove(display.asset);
    }
    display.entity = null;
    display.asset = null;
    display.active = false;
    this.options.entities[model].render!.enabled = true;
    const button = this.buttons[model];
    button.textContent = `${model.toUpperCase()}：高斯`;
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
    button.title = `加载模型 ${model.toUpperCase()} 原始 Gaussian（${formatBytes(this.options.bytes[model])}）`;
  }
}
