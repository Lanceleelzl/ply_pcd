import * as pc from 'playcanvas';
import type { XYZ } from '../../coordinate-math';
import { GaussianClipController } from '../../gaussian-clipping.ts';

export class SingleGaussianDisplay {
  private asset: pc.Asset | null = null;
  private entity: pc.Entity | null = null;
  private clip: GaussianClipController | null = null;
  private generation = 0;
  private destroyed = false;

  constructor(private readonly app: pc.Application, private readonly parent: pc.Entity,
    private readonly origin: XYZ, private readonly pointsVisible: (visible: boolean) => void) {}

  async show(url: string, filename: string): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    this.release();
    let direct: Awaited<ReturnType<typeof import('./direct-lcc-loader').loadDirectGaussian>> | null = null;
    let asset: pc.Asset;
    try {
      direct = /\.(?:spz|lcc2?)$/i.test(filename)
        ? await import('./direct-lcc-loader').then(module => module.loadDirectGaussian(this.app, url, filename))
        : null;
      asset = direct?.asset ?? new pc.Asset('Single model Gaussian', 'gsplat', { url, filename });
      if (generation !== this.generation) {
        asset.unload();
        if (direct) this.app.assets.remove(asset);
        return;
      }
      this.asset = asset;
      if (!direct) {
        this.app.assets.add(asset);
        await new Promise<void>((resolve, reject) => {
          const loaded = () => { asset.off('error', failed); resolve(); };
          const failed = (error: unknown) => { asset.off('load', loaded); reject(error); };
          asset.ready(loaded); asset.once('error', failed); this.app.assets.load(asset);
        });
      }
      if (generation !== this.generation) { asset.unload(); return; }
      const entity = new pc.Entity('Single model Gaussian');
      this.entity = entity;
      entity.addComponent('gsplat', { asset });
      entity.setLocalPosition((direct?.transform.translation.x ?? 0) - this.origin[0],
        (direct?.transform.translation.y ?? 0) - this.origin[1],
        (direct?.transform.translation.z ?? 0) - this.origin[2]);
      if (direct) {
        entity.setLocalRotation(direct.transform.rotation);
        entity.setLocalScale(direct.transform.scale, direct.transform.scale, direct.transform.scale);
      }
      this.parent.addChild(entity);
      this.clip = new GaussianClipController(entity.gsplat!);
      this.pointsVisible(false);
    } catch (error) {
      if (generation === this.generation) this.release();
      throw error;
    }
  }

  setClip(enabled: boolean, min: pc.Vec3, max: pc.Vec3, boxEnabled: boolean,
    worldToBox: pc.Mat4, originSides: pc.Vec3, worldToOrigin: pc.Mat4): void {
    this.clip?.setClipState(enabled, min, max, boxEnabled, worldToBox, originSides, worldToOrigin, true);
  }

  showPoints(): void { if (!this.destroyed) { ++this.generation; this.release(); } }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; ++this.generation; this.release();
  }

  private release(): void {
    this.clip = null;
    this.entity?.destroy();
    if (this.asset) { this.asset.unload(); this.app.assets.remove(this.asset); }
    this.entity = null; this.asset = null;
    if (!this.destroyed) this.pointsVisible(true);
  }
}
