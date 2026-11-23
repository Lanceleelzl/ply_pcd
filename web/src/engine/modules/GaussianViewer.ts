import * as pc from 'playcanvas';
import { RegistrationApplication } from '../core/Application';
import { SceneNavigationController } from '../core/SceneNavigationController';
import { ViewportCameraController, type CameraOrientation } from '../core/ViewportCameraController';
import type { TransformParameters, XYZ } from '../../coordinate-math';
import { GaussianClipController } from '../../gaussian-clipping';
import { readLocalTile } from './lcc-index';
import { ClippingHandles } from '../../clipping-handles';
import { buildProjectMap, worldBackdrop, mapWindow, type MapOptions } from '../../views/viewer/project-map';
import { geographicPosition, type GeoOrigin } from '../../views/viewer/viewer-origin';
import { TransformGizmoInput } from '../core/TransformGizmoInput';
import { mountClippingLabels } from '../../views/workbench/clipping-labels';

import type { ModelFile } from '../../views/viewer/local-model';
import { createPointCloudEntity, type PointCloudMaterial } from '../../point-cloud';
class Layer {
  root = new pc.Entity();
  asset?: pc.Asset;
  points?: PointCloudMaterial;
  environment?: pc.Entity;
  environmentAsset?: pc.Asset;
  clip?: GaussianClipController;
  bounds?: pc.BoundingBox;
}

export class GaussianViewer {
  private scene: RegistrationApplication;
  private camera?: ViewportCameraController;
  private navigation?: SceneNavigationController;
  private panPicker?: pc.Picker;
  private layers = new Map<number, Layer>();
  private closed = false;
  private map?: Awaited<ReturnType<typeof buildProjectMap>>;
  private mapRequest?: AbortController;
  private mapConfig?: {base: GeoOrigin; options: MapOptions; report: (value: string) => void};
  private backdropRequest?: AbortController;
  private releaseBackdrop?: () => void;
  private mapViewKey = '';
  private pendingMap?: AbortController;
  cancelMapChange() { this.pendingMap?.abort(); }
  async loadMap(base: GeoOrigin, options: MapOptions, report: (value: string) => void) {
    this.pendingMap?.abort();
    this.mapRequest?.abort();
    const request = this.pendingMap = new AbortController();
    const previous = this.mapConfig;
    const config = {base, options, report};
    const visible = options.imagery || options.labels || options.dem;
    try {
      if (visible) await this.refreshMap(config, request);
      request.signal.throwIfAborted();
      this.mapConfig = config;
      if (this.map) this.map.entity.enabled = visible;
      if (!visible) { this.mapViewKey = ''; report('地图图层已隐藏'); }
      const sameBackdrop = previous && previous.base.epsg === base.epsg &&
        previous.base.offset.every((v,i)=>v===base.offset[i]) && previous.options.provider===options.provider &&
        previous.options.key===options.key && JSON.stringify(previous.options.imageLayer)===JSON.stringify(options.imageLayer);
      if (!options.imagery || !sameBackdrop || !this.backdropRequest) {
        this.backdropRequest?.abort();
        this.backdropRequest = undefined;
        this.releaseBackdrop?.();
        this.releaseBackdrop = undefined;
        if (options.imagery && (options.provider==='tianditu' || options.imageLayer?.global)) {
          const backdrop = this.backdropRequest = new AbortController();
          void worldBackdrop(this.scene.app,base,options,backdrop.signal).then(release=>{
            if (backdrop.signal.aborted) release(); else this.releaseBackdrop=release;
          }).catch(()=>{ if (!backdrop.signal.aborted) this.backdropRequest=undefined; });
        }
      }
    } finally { request.abort(); if (this.pendingMap===request) this.pendingMap=undefined; }
  }
  private async refreshMap(config=this.mapConfig, pending?: AbortController) {
    if (!config || !this.camera || (this.pendingMap && !pending)) return;
    const {base,options,report}=config;
    if (!(options.imagery || options.labels || options.dem)) return;
    const view = this.camera.mapFootprint();
    this.scene.camera.camera!.farClip = Math.max(this.scene.camera.camera!.farClip, view.span * 4);
    if (!this.map && !this.framedModel) view.span = 2000;
    const window = mapWindow(base, view, this.camera.mapGroundCorners(options.heightOffset));
    const key = [window.left, window.top, window.z, window.cols, window.rows].join('/');
    if (!pending && this.mapViewKey === key) return;
    if (!pending) this.mapViewKey = key;
    this.mapRequest?.abort();
    const request = this.mapRequest = pending || new AbortController();
    try {
      const next = await buildProjectMap(this.scene.app, base, options, request.signal, window);
      if (request.signal.aborted) { next.destroy(); return; }
      const first = !this.map;
      this.map?.destroy();
      this.map = next;
      this.mapViewKey = key;
      if (first && !this.framedModel) this.fit();
      else this.scene.camera.camera!.farClip = Math.max(this.scene.camera.camera!.farClip, next.radius * 4);
      report('当前瓦片层级 ' + window.z);
    } catch (error) {
      if (!request.signal.aborted) { report(String(error)); throw error; }
    } finally { if (!pending) request.abort(); }
  }
  private axis = '';
  private cut = 0;
  private size = 1;
  private framedModel = false;
  showGrid = true;
  showAxes = true;
  private gridLines: pc.Vec3[] = [];
  private axes: pc.Vec3[] = [];
  private gizmo?: pc.TranslateGizmo | pc.RotateGizmo | pc.ScaleGizmo;
  private modelRotation?: pc.RotateGizmo;
  private modelScale?: pc.ScaleGizmo;
  private modelInput?: TransformGizmoInput;
  private dragging = false;
  private box = new pc.Mat4();
  private boxNode = new pc.Entity('Viewer clip box');
  private handles?: ClippingHandles;
  private boxRotation?: pc.RotateGizmo;
  private boxInput?: TransformGizmoInput;
  private labels: ReturnType<typeof mountClippingLabels>;
  private inputs = new AbortController();
  private boxChanged?: (value: TransformParameters) => void;
  private boxLines: pc.Vec3[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    viewport: HTMLElement,
    stats: (value: string) => void,
    private orientationChanged: (orientation: CameraOrientation) => void,
    private notifyWorldLimit: () => void,
  ) {
    this.scene = new RegistrationApplication({ canvas, viewport });
    const { app } = this.scene;
    app.root.addChild(this.boxNode);
    this.labels = mountClippingLabels(viewport);
    const events = { signal: this.inputs.signal, capture: true };
    canvas.addEventListener('pointerdown', e => {
      if (!this.dragging && this.handles?.pointerDown(e, !this.boxInput?.hovered)) { e.stopImmediatePropagation(); canvas.focus(); }
    }, events);
    canvas.addEventListener('pointerleave', () => this.handles?.pointerLeave(), events);
    canvas.addEventListener('pointermove', e => {
      if (this.handles?.pointerMove(e) && this.handles.dragging) {
        this.publishBox();
        e.stopImmediatePropagation();
      }
    }, events);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
      canvas.addEventListener(type, e => this.handles?.pointerUp(e), events);
    app.loader.getHandler('gsplat')!.addParser({
      canParse: (context) => context.ext === 'lcctile',
      load: async (url, callback) => {
        try {
          const { count, properties } = await readLocalTile(typeof url === 'string' ? url : url.load);
          if (this.closed) return;
          const data = new pc.GSplatData([{ name: 'vertex', count, properties }]);
          callback(null, new pc.GSplatResource(app.graphicsDevice, data));
        } catch (error) {
          callback(String(error));
        }
      },
    });
    app.scene.gsplat.splatBudgetMode = pc.GSPLAT_BUDGET_LIMIT;
    app.scene.gsplat.splatBudget = 5_000_000;
    const gridColor = new pc.Color(0.19, 0.25, 0.31);
    const boxColor = new pc.Color(0.2, 0.9, 1);
    const axisColors = [pc.Color.RED, pc.Color.RED, pc.Color.GREEN, pc.Color.GREEN, pc.Color.BLUE, pc.Color.BLUE];
    app.on('update', () => {
      if (this.showGrid) app.drawLines(this.gridLines, gridColor);
      if (this.showAxes) app.drawLines(this.axes, axisColors, false);
      if (this.axis === 'box') app.drawLines(this.boxLines, boxColor, false);
      this.handles?.update();
    });
    this.fit();
    let elapsed = 0;
    app.on('update', (dt: number) => {
      elapsed += dt;
      if (elapsed < 0.35) return;
      elapsed = 0;
      if (this.map && this.mapConfig) void this.refreshMap().catch(error => this.mapConfig?.report(String(error)));
      stats(`${app.stats.frame.fps} FPS · 本帧高斯 ${app.stats.frame.gsplats.toLocaleString()}`);
    });
  }

  async add(id: number, file: ModelFile, report: (value: string) => void) {
    const layer = new Layer();
    this.layers.set(id, layer);
    this.scene.app.root.addChild(layer.root);
    const app = this.scene.app;
    if (file.points) {
      const {cloud, total} = file.points;
      const entity = createPointCloudEntity(app, cloud, new pc.Color(0.84, 0.9, 1), file.filename);
      layer.root.addChild(entity);
      layer.points = entity.render!.meshInstances[0].material as PointCloudMaterial;
      layer.bounds = new pc.BoundingBox();
      layer.bounds.setMinMax(cloud.min, cloud.max);
      this.applyClip(layer);
      this.scene.camera.camera!.farClip = Math.max(this.scene.camera.camera!.farClip, layer.bounds.halfExtents.length() * 100);
      if (!this.framedModel && layer.root.enabled) { this.fit(); this.framedModel = true; }
      report('');
      return {count: total, displayed: cloud.count};
    }
    const asset = new pc.Asset(file.filename, 'gsplat', { url: file.url, filename: file.filename });
    try {
      app.assets.add(asset);
      await new Promise<void>((ok, fail) => {
        asset.once('load', ok);
        asset.once('error', fail);
        app.assets.load(asset);
      });
      if (this.closed) return;
      const resource = asset.resource as { aabb: pc.BoundingBox; numSplats: number; gsplatData?: {isCompressed?: boolean}; octree?: { lodLevels: number } };
      const bounds = resource.aabb.clone();
      const span = Math.max(0.1, bounds.halfExtents.length() * 2);
      if (!Number.isFinite(span)) throw new Error('无效的模型范围');
      const model = new pc.Entity();
      model.addComponent('gsplat', { asset });
      layer.root.addChild(model);
      if (resource.octree) model.gsplat!.lodBaseDistance = Math.max(0.1, span / 16);
      layer.asset = asset;
      layer.bounds = bounds;
      layer.clip = new GaussianClipController(model.gsplat!);
      this.applyClip(layer);
      this.scene.camera.camera!.farClip = Math.max(this.scene.camera.camera!.farClip, span * 50);
      if (!this.framedModel && layer.root.enabled) {
        this.fit();
        this.framedModel = true;
      }
      report('');
      return {count: resource.numSplats, compressed: resource.gsplatData?.isCompressed === true};
    } catch (error) {
      if (!this.closed) {
        asset.unload();
        app.assets.remove(asset);
        report(String(error));
      }

    }
  }
  removeLayer(id: number) {
    const layer = this.layers.get(id);
    if (!layer) return;
    layer.root.destroy();
    layer.points?.destroy();
    if (layer.environmentAsset) {
      layer.environmentAsset.unload();
      this.scene.app.assets.remove(layer.environmentAsset);
    }
    if (layer.asset) {
      layer.asset.unload();
      this.scene.app.assets.remove(layer.asset);
    }
    this.layers.delete(id);
    if (!this.layers.size) this.framedModel = false;
  }
  visible(id: number, value: boolean) {
    const layer = this.layers.get(id);
    if (layer) layer.root.enabled = value;
  }
  async showEnvironment(id: number, file: ModelFile, visible: boolean) {
    const layer=this.layers.get(id);
    if (!layer) return;
    if (layer.environment) { layer.environment.enabled=visible; return; }
    if (!visible) return;
    const assets=this.scene.app.assets;
    const asset=new pc.Asset(file.filename,'gsplat',{url:file.url,filename:file.filename});
    assets.add(asset);
    try {
      await new Promise<void>((ok,fail)=>{
        asset.once('load',ok); asset.once('error',fail); assets.load(asset);
      });
      if (this.closed || this.layers.get(id)!==layer) return;
      const node=new pc.Entity('环境');
      node.addComponent('gsplat',{asset});
      layer.root.addChild(node);
      layer.environment=node;
      layer.environmentAsset=asset;
    } finally {
      if (!layer.environmentAsset && !this.closed) { asset.unload(); assets.remove(asset); }
    }
  }
  loaded(id: number) {
    return !!this.layers.get(id)?.bounds;
  }
  transform(id: number, value: TransformParameters) {
    const root = this.layers.get(id)?.root;
    root?.setLocalPosition(...value.translation);
    root?.setLocalEulerAngles(...value.rotation_degrees);
    root?.setLocalScale(...value.scale);
    const layer = this.layers.get(id);
    if (layer && this.axis === 'box') this.applyClip(layer);
  }
  direction(value: XYZ) {
    this.camera?.setViewDirection(new pc.Vec3(...value));
  }
  orbit(x: number, y: number) {
    this.camera?.orbit(x, y);
  }
  edit(id: number, enabled: boolean, changed: (value: TransformParameters) => void) {
    this.clearFaceHandles();
    this.attachGizmo(this.layers.get(id)?.root, enabled ? 'model' : '', value => {
      const layer = this.layers.get(id);
      if (layer && this.axis === 'box') this.applyClip(layer);
      changed(value);
    });
  }
  private attachGizmo(root: pc.Entity | undefined, mode: string, changed: (value: TransformParameters) => void) {
    this.clearModelTools();
    this.gizmo?.destroy();
    this.gizmo = undefined;
    this.dragging = false;
    if (!root || !mode) return;
    const overlay =
      this.scene.app.scene.layers.getLayerByName('Viewer gizmos') ??
      pc.TranslateGizmo.createLayer(this.scene.app, 'Viewer gizmos');
    const gizmo = (this.gizmo = new pc.TranslateGizmo(this.scene.camera.camera!, overlay));
    gizmo.attach([root]);
    gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => {
      this.dragging = true;
      this.navigation?.clear();
    });
    gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
      this.dragging = false;
    });
    const xyz = (v: pc.Vec3): XYZ => [v.x, v.y, v.z];
    const publish = () => {
      changed({
        translation: xyz(root.getLocalPosition()),
        rotation_degrees: xyz(root.getLocalEulerAngles()),
        scale: xyz(root.getLocalScale()),
      });
    };
    gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, publish);
    if (mode === 'model') {
      const camera = this.scene.camera.camera!;
      const rotate = this.modelRotation = new pc.RotateGizmo(camera, overlay);
      const scale = this.modelScale = new pc.ScaleGizmo(camera, overlay);
      gizmo.axisLineLength = 0.65;
      gizmo.enableShape('xyz', false);
      rotate.centerRadius = 0.001;
      rotate.ringTolerance = 0.025;
      scale.axisGap = 0.92;
      scale.axisLineLength = 0.23;
      for (const plane of ['xy', 'xz', 'yz'] as const) scale.enableShape(plane, false);
      for (const tool of [rotate, scale]) {
        tool.attach([root]);
        tool.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, publish);
      }
      this.modelInput = new TransformGizmoInput(gizmo, rotate, active => {
        this.dragging = active;
        if (active) this.navigation?.clear();
      }, scale);
    }
  }
  private clearModelTools() {
    this.modelInput?.destroy();
    this.modelInput = undefined;
    this.modelRotation?.destroy();
    this.modelRotation = undefined;
    this.modelScale?.destroy();
    this.modelScale = undefined;
  }
  private clearFaceHandles() {
    this.boxInput?.destroy();
    this.boxInput = undefined;
    this.boxRotation?.destroy();
    this.boxRotation = undefined;
    this.handles?.destroy();
    this.handles = undefined;
  }
  boxTool(changed: (value: TransformParameters) => void) {
    this.boxChanged = changed;
    if (this.handles) return;
    this.attachGizmo(this.boxNode, 'move', () => this.publishBox());
    const translate = this.gizmo as pc.TranslateGizmo;
    translate.axisGap = 0.08;
    translate.axisLineLength = 0.72;
    translate.axisPlaneSize = 0.14;
    translate.axisPlaneGap = 0.22;
    translate.flipPlanes = true;
    const app = this.scene.app;
    const overlay = app.scene.layers.getLayerByName('Viewer clip rotation')
      ?? pc.RotateGizmo.createLayer(app, 'Viewer clip rotation');
    const rotate = this.boxRotation = new pc.RotateGizmo(this.scene.camera.camera!, overlay);
    rotate.centerRadius = 0.001;
    rotate.ringTolerance = 0.025;
    rotate.attach([this.boxNode]);
    rotate.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => this.publishBox());
    this.boxInput = new TransformGizmoInput(translate, rotate, active => {
      this.dragging = active;
      if (active) this.navigation?.clear();
    });
    const extent = this.boxNode.getLocalScale().clone().mulScalar(0.5);
    const min = extent.clone().mulScalar(-1);
    const disabled = { x: false, y: false, z: false };
    const state = { min, max: extent, minEnabled: disabled, maxEnabled: disabled };
    this.handles = new ClippingHandles(this.scene.app, this.scene.camera, this.canvas,
      () => this.boxNode, min, extent, () => 'box', () => state, () => {}, () => true,
      active => { this.dragging = active; if (active) this.navigation?.clear(); },
      { set: (kind, axis, side, point) => this.labels.set(kind, axis, side,
        point && kind === 'box' ? { ...point, visible: true } : point) });
    this.handles.update();
  }
  private publishBox() {
    const xyz = (v: pc.Vec3): XYZ => [v.x, v.y, v.z];
    const value = { translation: xyz(this.boxNode.getLocalPosition()),
      rotation_degrees: xyz(this.boxNode.getLocalEulerAngles()), scale: xyz(this.boxNode.getLocalScale()) };
    this.section('box', this.cut, value);
    this.boxChanged?.(value);
  }
  focusLayer(id: number) {
    const layer = this.layers.get(id);
    if (!layer?.bounds || !this.camera) return;
    const bounds = new pc.BoundingBox();
    bounds.setFromTransformedAabb(layer.bounds, layer.root.getWorldTransform());
    this.camera.frame({ min: bounds.getMin(), max: bounds.getMax() });
    this.camera.setViewDirection(new pc.Vec3(0, -1, 1));
  }
  fit() {
    const bounds = new pc.BoundingBox();
    let any = false;
    for (const layer of this.layers.values()) {
      if (layer.root.enabled && layer.bounds) {
        const world = new pc.BoundingBox();
        world.setFromTransformedAabb(layer.bounds, layer.root.getWorldTransform());
        bounds.add(world);
        any = true;
      }
    }
    const radius = any ? Math.max(
      bounds.getMin().length(),
      bounds.getMax().length(),
      bounds.center.length() + bounds.halfExtents.length(),
      0.1,
    ) : this.map?.entity.enabled ? this.map.radius : 10;
    this.size = radius * 2;
    const spacing = 10 ** Math.floor(Math.log10(radius / 5));
    const extent = Math.ceil(radius * 2 / spacing) * spacing;
    this.gridLines = [];
    for (let i = -Math.round(extent / spacing); i <= Math.round(extent / spacing); i++) {
      const p = i * spacing;
      this.gridLines.push(new pc.Vec3(p, -extent, 0), new pc.Vec3(p, extent, 0),
        new pc.Vec3(-extent, p, 0), new pc.Vec3(extent, p, 0));
    }
    this.axes = [pc.Vec3.ZERO, new pc.Vec3(radius, 0, 0), pc.Vec3.ZERO, new pc.Vec3(0, radius, 0),
      pc.Vec3.ZERO, new pc.Vec3(0, 0, radius)];
    const ext = new pc.Vec3(radius, radius, radius);
    const box = { min: ext.clone().mulScalar(-1), max: ext };
    this.navigation?.destroy();
    const camera = (this.camera = new ViewportCameraController({
      canvas: this.canvas,
      camera: this.scene.camera,
      getBounds: () => box,
      baseDiagonal: this.size,
      orientationChanged: this.orientationChanged,
    }));
    camera.frame(box);
    camera.setViewDirection(new pc.Vec3(0, -1, 1));
    this.scene.camera.camera!.farClip = Math.max(1000, radius * 32);
    this.navigation = new SceneNavigationController({
      canvas: this.canvas,
      rightButtonPan: true,
      beginPan: async (x, y, pointer) => {
        const ray = camera.pointerRay(x, y);
        const terrain = this.map?.pick(ray);
        if (terrain) return camera.anchoredPan(ray, terrain, true);
        if (this.releaseBackdrop && this.mapConfig?.options.imagery) {
          const ground = new pc.Vec3();
          if (new pc.Plane(new pc.Vec3(0, 0, 1), 0).intersectsRay(ray, ground))
            return camera.anchoredPan(ray, ground, true);
        }
        let hit: pc.Vec3 | null = null;
        if ([...this.layers.values()].some(layer => layer.root.enabled && layer.asset)) {
          const rect = this.canvas.getBoundingClientRect();
          const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
          const app = this.scene.app;
          try {
            const picker = this.panPicker ??= new pc.Picker(app, w, h, true);
            picker.resize(w, h);
            picker.prepare(this.scene.camera.camera!, app.scene, [app.scene.layers.getLayerById(pc.LAYERID_WORLD)!]);
            hit = await picker.getWorldPointAsync((x - rect.left) * w / rect.width, (y - rect.top) * h / rect.height);
          } catch { /* Depth readback may be unavailable after a device loss. */ }
        }
        const current = pointer();
        return camera.anchoredPan(camera.pointerRay(current.x, current.y), hit, false);
      },
      blocked: () => this.dragging,
      speed: () => this.size * 0.2,
      camera: {
        move: (f, r, u) => camera.moveByLocal(f, r, u),
        look: (x, y) => camera.orbitByPixels(x, y),
        pan: (x, y) => camera.panByPixels(x, y),
        dolly: (d) => {
          const config = this.mapConfig;
          let width = Infinity;
          if (config && (config.options.imagery || config.options.labels || config.options.dem)) {
            const latitude = geographicPosition(config.base)[1];
            width = 40075016.69 * Math.cos(latitude * Math.PI / 180);
          }
          if (camera.zoom(d, width)) this.notifyWorldLimit();
        },
      },
    });
    this.canvas.focus();
  }
  projection(ortho: boolean) {
    this.camera?.setProjection(ortho);
  }
  initialSectionBox(): TransformParameters {
    let bounds: pc.BoundingBox | undefined;
    for (const layer of this.layers.values()) {
      if (!layer.root.enabled || !layer.bounds) continue;
      const world = new pc.BoundingBox();
      world.setFromTransformedAabb(layer.bounds, layer.root.getWorldTransform());
      if (bounds) bounds.add(world);
      else bounds = world;
    }
    const c = bounds?.center ?? pc.Vec3.ZERO;
    const h = bounds?.halfExtents ?? new pc.Vec3(5, 5, 5);
    return { translation: [c.x, c.y, c.z], rotation_degrees: [0,0,0],
      scale: [Math.max(0.1, 2*h.x), Math.max(0.1, 2*h.y), Math.max(0.1, 2*h.z)] };
  }
  section(axis: string, position: number, box: TransformParameters) {
    this.boxNode.setLocalPosition(...box.translation);
    this.boxNode.setLocalEulerAngles(...box.rotation_degrees);
    this.boxNode.setLocalScale(...box.scale);
    this.axis = axis;
    this.cut = position;
    this.box
      .setTRS(
        new pc.Vec3(...box.translation),
        new pc.Quat().setFromEulerAngles(...box.rotation_degrees),
        new pc.Vec3(...box.scale),
      );
    if (axis === 'box') {
      const corners = Array.from({ length: 8 }, (_, i) => this.box.transformPoint(new pc.Vec3(
        (i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5)));
      this.boxLines = [];
      corners.forEach((corner, i) => {
        for (const bit of [1, 2, 4]) if (!(i & bit)) this.boxLines.push(corner, corners[i | bit]);
      });
    }
    this.box.invert();
    for (const layer of this.layers.values()) this.applyClip(layer);
  }
  private applyClip(layer: Layer) {
    const min = new pc.Vec3(-1e30, -1e30, -1e30),
      max = min.clone().mulScalar(-1);
    if (this.axis === 'x' || this.axis === 'y' || this.axis === 'z') max[this.axis] = this.cut;
    layer.points?.setClipState(!!this.axis, min, max, this.axis === 'box', this.box, pc.Vec3.ZERO, pc.Mat4.IDENTITY);
    layer.clip?.setClipState(
      !!this.axis,
      min,
      max,
      this.axis === 'box',
      this.axis === 'box' ? new pc.Mat4().mul2(this.box, layer.root.getWorldTransform()) : this.box,
      pc.Vec3.ZERO,
      pc.Mat4.IDENTITY,
      true,
    );
  }
  destroy() {
    this.closed = true;
    this.backdropRequest?.abort();
    this.releaseBackdrop?.();
    this.panPicker?.destroy();
    this.mapRequest?.abort();
    this.map?.destroy();
    this.inputs.abort();
    this.clearFaceHandles();
    this.labels.destroy();
    this.clearModelTools();
    this.gizmo?.destroy();
    this.navigation?.destroy();
    for (const id of this.layers.keys()) this.removeLayer(id);
    this.scene.destroy();
  }
}
