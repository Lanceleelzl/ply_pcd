import * as pc from 'playcanvas';
import { apiFetch, getApiKey } from '../../api/api-auth.ts';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
import { GaussianClipController } from '../../gaussian-clipping.ts';

interface GaussianDisplayOptions {
  app: pc.Application;
  entities: Record<ModelId, pc.Entity>;
  urls: Record<ModelId, string | undefined>;
  filenames: Record<ModelId, string | undefined>;
  origins: Record<ModelId, XYZ>;
  clippingEnabled(): boolean;
  clipStateChanged(): void;
  presentationChanged(): void;
  displayChanged(model: ModelId, state: { active: boolean; loading: boolean }): void;
  statusChanged(message: string, error: boolean): void;
}

interface GaussianDisplay {
  entity: pc.Entity | null;
  asset: pc.Asset | null;
  clipController: GaussianClipController | null;
  active: boolean;
  loading: boolean;
  objectUrl: string | null;
}

const models: ModelId[] = ['a', 'b'];

export class GaussianDisplayController {
  private readonly displays: Record<ModelId, GaussianDisplay> = {
    a: { entity: null, asset: null, clipController: null, active: false, loading: false, objectUrl: null },
    b: { entity: null, asset: null, clipController: null, active: false, loading: false, objectUrl: null },
  };
  private destroyed = false;

  constructor(private readonly options: GaussianDisplayOptions) {}

  refreshStatus(error?: string): void {
    const activeModels = models.filter(model => this.displays[model].active);
    if (error) {
      this.options.statusChanged(error, true);
      return;
    }
    if (activeModels.length === 0) {
      this.options.statusChanged('', false);
      return;
    }
    const names = activeModels.map(model => model.toUpperCase()).join('、');
    this.options.statusChanged(this.options.clippingEnabled()
      ? `模型 ${names} 正在显示完整 Gaussian，并与当前剖切范围同步；剖切仅影响视觉预览。`
      : `模型 ${names} 正在显示完整 Gaussian；该模式仅用于视觉确认，不改变 ICP 输入。`, false);
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
    models.forEach(model => this.release(model));
  }

  async toggle(model: ModelId): Promise<void> {
    const url = this.options.urls[model];
    const display = this.displays[model];
    if (!url || display.loading || this.destroyed) return;
    display.loading = true;
    this.publish(model);
    try {
      if (display.active) {
        this.release(model);
        this.refreshStatus();
        this.options.presentationChanged();
        return;
      }
      let assetUrl = url;
      if (getApiKey() && url.startsWith('/api/v2/')) {
        const response = await apiFetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        display.objectUrl = URL.createObjectURL(await response.blob());
        assetUrl = display.objectUrl;
      }
      const asset = new pc.Asset(`Model ${model.toUpperCase()} Original Gaussian PLY`, 'gsplat', {
        url: assetUrl,
        filename: this.options.filenames[model] ?? `model-${model}-original-gaussian.ply`,
      });
      display.asset = asset;
      this.options.app.assets.add(asset);
      await new Promise<void>((resolve, reject) => {
        asset.ready(() => resolve());
        asset.once('error', reject);
        this.options.app.assets.load(asset);
      });
      if (this.destroyed) {
        asset.unload();
        return;
      }
      const entity = new pc.Entity(`Model ${model.toUpperCase()} Original Gaussian`);
      entity.addComponent('gsplat', { asset });
      const origin = this.options.origins[model];
      entity.setLocalPosition(-origin[0], -origin[1], -origin[2]);
      this.options.entities[model].addChild(entity);
      display.entity = entity;
      display.clipController = new GaussianClipController(entity.gsplat!);
      display.active = true;
      this.options.entities[model].render!.enabled = false;
      this.options.clipStateChanged();
      this.refreshStatus();
      this.options.presentationChanged();
    } catch (error) {
      if (!this.destroyed) {
        this.release(model);
        this.refreshStatus(`模型 ${model.toUpperCase()} Gaussian 加载失败，已保留中心点：${String(error)}`);
        console.error(error);
      }
    } finally {
      display.loading = false;
      if (!this.destroyed) this.publish(model);
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
    if (display.objectUrl) URL.revokeObjectURL(display.objectUrl);
    display.objectUrl = null;
    display.active = false;
    this.options.entities[model].render!.enabled = true;
    if (!this.destroyed) this.publish(model);
  }

  private publish(model: ModelId): void {
    const { active, loading } = this.displays[model];
    this.options.displayChanged(model, { active, loading });
  }
}
