import * as pc from 'playcanvas';
import type { XYZ } from '../../coordinate-math';
import { GaussianClipController } from '../../gaussian-clipping.ts';
import { MergeGaussianClip } from '../../views/merge/MergeGaussianClip';
import type { Region } from '../../api/merge-api';
import type { EditorRule } from '../../api/gaussian-editor-api';
import { EditorGaussianClip } from '../../views/editor/EditorGaussianClip';

export class SingleGaussianDisplay {
  private asset: pc.Asset | null = null;
  private entity: pc.Entity | null = null;
  private clip: GaussianClipController | null = null;
  private mergeClip: MergeGaussianClip | null = null;
  private editorClip: EditorGaussianClip | null = null;
  private mergeRules: { regions: Region[]; model: number; enabled: boolean } | null = null;
  private editorRules: { rules: EditorRule[]; origin: XYZ } | null = null;
  private generation = 0;
  private destroyed = false;

  constructor(private readonly app: pc.Application, private readonly parent: pc.Entity,
    private readonly origin: XYZ, private readonly pointsVisible: (visible: boolean) => void,
    private readonly clipMode: 'standard' | 'merge' | 'editor' = 'standard') {}

  async show(url: string, filename: string, lodIndex?: number, onStage?: (stage: string) => void,
    adaptiveLod = false): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    this.release();
    const editorStream = this.clipMode === 'editor' && filename === 'lod-meta.json';
    let direct: Awaited<ReturnType<typeof import('./direct-lcc-loader').loadDirectGaussian>> | null = null;
    let asset: pc.Asset;
    try {
      onStage?.('读取并解析模型');
      direct = /\.(?:spz|lcc2?)$/i.test(filename) || filename === 'lod-meta.json' && !editorStream
        ? await import('./direct-lcc-loader').then(module => module.loadDirectGaussian(this.app, url, filename, lodIndex))
        : null;
      asset = direct?.asset ?? new pc.Asset('Single model Gaussian', 'gsplat', { url, filename });
      if (generation !== this.generation) {
        asset.unload();
        if (direct) this.app.assets.remove(asset);
        return;
      }
      this.asset = asset;
      if (editorStream)
        this.app.scene.gsplat.splatBudget = adaptiveLod ? 24_000_000 : 5_000_000;
      if (!direct) {
        this.app.assets.add(asset);
        let reportedPercent = -1;
        asset.on('progress', (received: number, total: number) => {
          if (generation !== this.generation || !onStage || !(total > 0)) return;
          const percent = Math.min(100, Math.floor(received / total * 20) * 5);
          if (percent === reportedPercent) return;
          reportedPercent = percent;
          onStage(percent === 100 ? '模型下载完成，正在解析' : `下载模型 ${percent}%`);
        });
        await new Promise<void>((resolve, reject) => {
          const loaded = () => { asset.off('error', failed); resolve(); };
          const failed = (error: unknown) => { asset.off('load', loaded); reject(error); };
          asset.ready(loaded); asset.once('error', failed); this.app.assets.load(asset);
        });
      }
      if (generation !== this.generation) { asset.unload(); return; }
      onStage?.('创建渲染对象');
      const entity = new pc.Entity('Single model Gaussian');
      this.entity = entity;
      entity.addComponent('gsplat', { asset });
      if (editorStream && lodIndex !== undefined) {
        entity.gsplat!.lodRangeMin = lodIndex;
        const lodLevels = (asset.resource as { octree?: { lodLevels: number } }).octree?.lodLevels;
        entity.gsplat!.lodRangeMax = adaptiveLod && lodLevels ? lodLevels - 1 : lodIndex;
      }
      entity.setLocalPosition((direct?.transform.translation.x ?? 0) - this.origin[0],
        (direct?.transform.translation.y ?? 0) - this.origin[1],
        (direct?.transform.translation.z ?? 0) - this.origin[2]);
      if (direct) {
        entity.setLocalRotation(direct.transform.rotation);
        entity.setLocalScale(direct.transform.scale, direct.transform.scale, direct.transform.scale);
      }
      this.parent.addChild(entity);
      if (this.clipMode === 'merge') {
        this.mergeClip = new MergeGaussianClip(this.app, entity.gsplat!);
        if (this.mergeRules) this.mergeClip.setRules(this.mergeRules.regions, this.mergeRules.model, this.mergeRules.enabled);
      } else if (this.clipMode === 'editor') {
        this.editorClip = new EditorGaussianClip(this.app, entity.gsplat!);
        this.editorClip.setRules(this.editorRules?.rules ?? [], this.editorRules?.origin ?? this.origin);
        this.clip = this.editorClip;
      } else this.clip = new GaussianClipController(entity.gsplat!);
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

  setMergeClip(regions: Region[], model: number, enabled: boolean): void {
    this.mergeRules = { regions, model, enabled };
    this.mergeClip?.setRules(regions, model, enabled);
  }

  setEditorRules(rules: EditorRule[], origin: XYZ): void {
    this.editorRules = { rules, origin };
    this.editorClip?.setRules(rules, origin);
  }

  showPoints(): void { if (!this.destroyed) { ++this.generation; this.release(); } }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; ++this.generation; this.release();
  }

  private release(): void {
    this.clip = null;
    this.editorClip?.destroy(); this.editorClip = null;
    this.mergeClip?.destroy(); this.mergeClip = null;
    this.entity?.destroy();
    if (this.asset) { this.asset.unload(); this.app.assets.remove(this.asset); }
    this.entity = null; this.asset = null;
    if (!this.destroyed) this.pointsVisible(true);
  }
}
