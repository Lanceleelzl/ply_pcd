import * as pc from 'playcanvas';
import { RegistrationApplication } from '../core/Application';
import { SceneNavigationController } from '../core/SceneNavigationController';
import { ViewportCameraController, type CameraOrientation } from '../core/ViewportCameraController';
import type { TransformParameters, XYZ } from '../../coordinate-math';
import { applySections, boundaryLines, type ViewerSection } from '../../views/viewer/viewer-sections';
import { readLocalTile } from './lcc-index';
import { ClippingHandles } from '../../clipping-handles';
import { buildProjectMap, worldBackdrop, mapWindow, type MapOptions } from '../../views/viewer/project-map';
import { geographicPosition, type GeoOrigin } from '../../views/viewer/viewer-origin';
import { TransformGizmoInput } from '../core/TransformGizmoInput';
import { mountClippingLabels } from '../../views/workbench/clipping-labels';

import type { ModelFile } from '../../views/viewer/local-model';
import {VectorLayer} from '../../views/viewer/vector-layer';
import type {VectorData} from '../../views/viewer/vector-data';
import { CopcLayer } from './copc-layer';
import { createPointCloudEntity, type PointCloudMaterial } from '../../point-cloud';
class Layer {
  root = new pc.Entity();
  asset?: pc.Asset;
  vector?: VectorLayer;
  points?: PointCloudMaterial;
  pointEntity?: pc.Entity;
  copc?: CopcLayer;
  environment?: pc.Entity;
  environmentAsset?: pc.Asset;
  model?: pc.Entity;
  file!: ModelFile;
  sections: ViewerSection[] = [];
  lines: pc.Vec3[] = [];
  environmentVisible = false;
  bounds?: pc.BoundingBox;
}

export class GaussianViewer {
  private scene: RegistrationApplication;
  private readonly vectorOverlay: pc.Layer;
  private camera?: ViewportCameraController;
  private navigation?: SceneNavigationController;
  private panPicker?: pc.Picker;
  private annotationPicker?: pc.Picker;
  private annotationPickQueue: Promise<unknown> = Promise.resolve();
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
      if (!visible) this.updateVectorHeights();
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
      this.updateVectorHeights();
      this.mapViewKey = key;
      if (first && !this.framedModel) this.fit();
      else this.scene.camera.camera!.farClip = Math.max(this.scene.camera.camera!.farClip, next.radius * 4);
      report('当前瓦片层级 ' + window.z);
    } catch (error) {
      if (!request.signal.aborted) { report(String(error)); throw error; }
    } finally { if (!pending) request.abort(); }
  }
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
  private annotationNode: pc.Entity;
  private annotationGizmo?: pc.TranslateGizmo;
  private annotationMove?: (world: XYZ) => void;
  private annotationDragging = false;
  private annotationHovered = false;
  private annotationInteracted = false;
  private dragging = false;
  private boxNode: pc.Entity;
  private handles?: ClippingHandles;
  private boxRotation?: pc.RotateGizmo;
  private boxInput?: TransformGizmoInput;
  private labels: ReturnType<typeof mountClippingLabels>;
  private inputs = new AbortController();
  private boxChanged?: (value: TransformParameters) => void;
  private sceneSections: ViewerSection[] = [];
  private sceneLines: pc.Vec3[] = [];
  private axisLayer?: number;
  private hoveredPlane?: ViewerSection;
  private planeDrag?: { rule: ViewerSection; pointer: number; x: number; y: number; cut: number; dx: number; dy: number };

  axisTools(layerId?: number) {
    if (this.axisLayer === layerId) return;
    this.endPlaneDrag();
    this.axisLayer = layerId;
  }
  private hoverPlane(rule?: ViewerSection) {
    if (rule === this.hoveredPlane) return;
    this.hoveredPlane = rule;
    this.canvas.style.cursor = rule ? 'grab' : '';
  }
  private endPlaneDrag() {
    const drag = this.planeDrag;
    this.planeDrag = undefined;
    if (drag && this.canvas.hasPointerCapture(drag.pointer)) this.canvas.releasePointerCapture(drag.pointer);
    this.hoverPlane();
  }
  // Fit the projected corners around the center, including perspective foreshortening.
  private viewportSectionSize(center: pc.Vec3, axis: ViewerSection['axis']) {
    const camera = this.scene.camera;
    const lens = camera.camera!;
    const ortho = lens.projection === pc.PROJECTION_ORTHOGRAPHIC;
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const halfY = ortho ? lens.orthoHeight : Math.tan(lens.fov * Math.PI / 360) / (lens.horizontalFov ? aspect : 1);
    const halfX = halfY * aspect;
    const relative = center.clone().sub(camera.getPosition());
    const forward = camera.forward, right = camera.right, up = camera.up;
    const depth = Math.max(lens.nearClip, relative.dot(forward));
    const slopeX = ortho ? 0 : relative.dot(right) / depth;
    const slopeY = ortho ? 0 : relative.dot(up) / depth;
    let limit = 0;
    for (let i=0; i<8; i++) {
      const corner = new pc.Vec3((i&1)-0.5, ((i>>1)&1)-0.5, ((i>>2)&1)-0.5);
      if (axis !== 'box') corner[axis] = 0;
      const dz = ortho ? 0 : corner.dot(forward);
      const x = Math.abs(corner.dot(right)-slopeX*dz) / halfX;
      const y = Math.abs(corner.dot(up)-slopeY*dz) / halfY;
      limit = Math.max(limit, 1.5*Math.max(x,y)-dz);
    }
    return (ortho ? 1 : depth) / Math.max(1e-8,limit);
  }
  private planeBounds(rule: ViewerSection) {
    const center = new pc.Vec3(...rule.box.translation);
    if (rule.axis !== 'box') center[rule.axis] = rule.cut;
    const size = this.viewportSectionSize(center,rule.axis);
    return {...rule, box:{...rule.box, scale:[size,size,size] as XYZ}};
  }
  private pickPlane(event: PointerEvent) {
    const layer = this.axisLayer === undefined ? undefined : this.layers.get(this.axisLayer);
    if ((this.axisLayer !== 0 && !layer?.root.enabled) || !this.camera) return;
    const ray = this.camera.pointerRay(event.clientX,event.clientY);
    const rect = this.canvas.getBoundingClientRect();
    const camera = this.scene.camera.camera!;
    let closest: {rule: ViewerSection; point: pc.Vec3; distance: number} | undefined;
    for (const rule of layer?.sections ?? this.sceneSections) {
      const axis = rule.axis;
      if (!rule.boundary || axis==='box') continue;
      const display = this.planeBounds(rule);
      const distance = (rule.cut-ray.origin[axis])/ray.direction[axis];
      let point: pc.Vec3 | undefined;
      if (Number.isFinite(distance) && distance >= 0) {
        const hit = ray.direction.clone().mulScalar(distance).add(ray.origin);
        if ((['x','y','z'] as const).every((dim,i)=>dim===axis || Math.abs(hit[dim]-rule.box.translation[i])<=display.box.scale[i]/2)) point=hit;
      }
      // A plane viewed edge-on is still selectable along its visible outline.
      if (!point) {
        const lines=boundaryLines(display);
        for (let i=0;i<lines.length;i+=2) {
          const a=camera.worldToScreen(lines[i]), b=camera.worldToScreen(lines[i+1]);
          const dx=b.x-a.x, dy=b.y-a.y, x=event.clientX-rect.left-a.x, y=event.clientY-rect.top-a.y;
          const t=Math.max(0,Math.min(1,(x*dx+y*dy)/(dx*dx+dy*dy || 1)));
          if (Math.hypot(x-t*dx,y-t*dy)>4) continue;
          const hit=new pc.Vec3().lerp(lines[i],lines[i+1],t);
          if (hit.clone().sub(ray.origin).dot(ray.direction)>0) { point=hit; break; }
        }
      }
      if (point) {
        const depth=point.distance(ray.origin);
        if (!closest || depth<closest.distance) closest={rule,point,distance:depth};
      }
    }
    return closest;
  }

  constructor(
    private canvas: HTMLCanvasElement,
    viewport: HTMLElement,
    stats: (value: string) => void,
    private orientationChanged: (orientation: CameraOrientation) => void,
    private notifyWorldLimit: () => void,
  ) {
    this.scene = new RegistrationApplication({ canvas, viewport });
    const { app } = this.scene;
    app.scene.gsplat.enableIds = true;
    app.scene.gsplat.alphaClip = 0.05;
    this.vectorOverlay = new pc.Layer({name:'Vector overlay'});
    app.scene.layers.pushTransparent(this.vectorOverlay);
    const cameraComponent = this.scene.camera.camera!;
    cameraComponent.layers = [...cameraComponent.layers, this.vectorOverlay.id];
    this.boxNode = new pc.Entity('Viewer clip box', app);
    app.root.addChild(this.boxNode);
    this.annotationNode = new pc.Entity('Viewer annotation point', app);
    app.root.addChild(this.annotationNode);
    this.labels = mountClippingLabels(viewport);
    const events = { signal: this.inputs.signal, capture: true };
    canvas.addEventListener('pointerdown', e => {
      if (!this.dragging && this.handles?.pointerDown(e, !this.boxInput?.hovered)) { e.stopImmediatePropagation(); canvas.focus(); return; }
      if (e.button!==0 || this.dragging || this.boxInput?.hovered || this.planeDrag) return;
      const hit=this.pickPlane(e);
      if (!hit || hit.rule.axis==='box') return;
      const camera=this.scene.camera.camera!;
      const length=Math.max(hit.distance*0.01,0.001);
      const end=hit.point.clone();
      end[hit.rule.axis]+=length;
      const a=camera.worldToScreen(hit.point), b=camera.worldToScreen(end);
      let dx=b.x-a.x, dy=b.y-a.y;
      if (Math.hypot(dx,dy)<0.5) {
        const up=camera.worldToScreen(hit.point.clone().add(this.scene.camera.up.clone().mulScalar(length)));
        dx=0; dy=-Math.max(0.5,Math.abs(up.y-a.y));
      }
      const factor=length/(dx*dx+dy*dy);
      this.planeDrag={rule:hit.rule,pointer:e.pointerId,x:e.clientX,y:e.clientY,cut:hit.rule.cut,dx:dx*factor,dy:dy*factor};
      this.hoverPlane(hit.rule);
      canvas.style.cursor='grabbing';
      this.navigation?.clear();
      canvas.setPointerCapture(e.pointerId);
      canvas.focus();
      e.stopImmediatePropagation();
    }, events);
    canvas.addEventListener('pointerleave', () => { this.handles?.pointerLeave(); if (!this.planeDrag) this.hoverPlane(); }, events);
    canvas.addEventListener('pointermove', e => {
      const drag=this.planeDrag;
      if (drag && drag.pointer===e.pointerId) {
        drag.rule.cut=drag.cut+(e.clientX-drag.x)*drag.dx+(e.clientY-drag.y)*drag.dy;
        e.stopImmediatePropagation();
        return;
      }
      if (this.handles?.pointerMove(e) && this.handles.dragging) {
        this.publishBox();
        e.stopImmediatePropagation();
      } else if (!e.buttons) this.hoverPlane(this.pickPlane(e)?.rule);
    }, events);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
      canvas.addEventListener(type, e => {
        if (this.planeDrag?.pointer===e.pointerId) this.endPlaneDrag();
        else this.handles?.pointerUp(e);
      }, events);
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
      for (const layer of this.layers.values()) if (layer.root.enabled && layer.lines.length) app.drawLines(layer.lines, boxColor, false);
      if (this.sceneLines.length) app.drawLines(this.sceneLines, boxColor, false);
      const drawPlanes = (sections: ViewerSection[]) => {
        for (const rule of sections) {
          if (rule.axis !== 'box' && rule.boundary)
            app.drawLines(boundaryLines(this.planeBounds(rule)), rule===this.hoveredPlane ? pc.Color.YELLOW : boxColor, false);
        }
      };
      drawPlanes(this.sceneSections);
      for (const layer of this.layers.values()) if (layer.root.enabled) drawPlanes(layer.sections);
      this.handles?.update();
    });
    this.fit();
    let elapsed = 0;
    app.on('update', (dt: number) => {
      elapsed += dt;
      if (elapsed < 0.35) return;
      elapsed = 0;
      for (const layer of this.layers.values()) layer.copc?.update(this.scene.camera.camera!);
      if (this.map && this.mapConfig) void this.refreshMap().catch(error => this.mapConfig?.report(String(error)));
      stats(`${app.stats.frame.fps} FPS · 本帧高斯 ${app.stats.frame.gsplats.toLocaleString()}`);
    });
  }

  private groundHeight=(lon:number,lat:number)=>this.map?.entity.enabled ? this.map.groundHeight(lon,lat) : 0;
  private updateVectorHeights() {
    for(const layer of this.layers.values()) if(layer.vector?.usesTerrain) layer.vector.rebuild(this.groundHeight);
  }
  async addVector(id:number,data:VectorData,base:GeoOrigin) {
    const vector=new VectorLayer(this.scene.app,data,base);
    try {
      await vector.loadIcons();
      if(this.closed) throw Error('视口已关闭');
      vector.rebuild(this.groundHeight);
      const layer=new Layer();
      this.scene.camera.camera!.farClip=Math.max(this.scene.camera.camera!.farClip,vector.bounds.halfExtents.length()*50);
      layer.vector=vector;
      layer.bounds=vector.bounds;
      layer.root.addChild(vector.root);
      this.scene.app.root.addChild(layer.root);
      this.layers.set(id,layer);
    } catch(error) { vector.destroy(); throw error; }
  }
  async add(id: number, file: ModelFile, report: (value: string) => void) {
    const layer = new Layer();
    layer.file = file;
    this.layers.set(id, layer);
    this.scene.app.root.addChild(layer.root);
    const app = this.scene.app;
    if (file.copc) {
      const data=file.copc;
      layer.bounds=data.bounds;
      layer.copc=new CopcLayer(data,layer.root,app,material=>applySections(material,[[...this.sceneSections,...layer.sections]]),report);
      this.scene.camera.camera!.farClip=Math.max(this.scene.camera.camera!.farClip,data.bounds.halfExtents.length()*100);
      if (!this.framedModel && layer.root.enabled) { this.fit(); this.framedModel=true; }
      report('');
      return {count:data.header.pointCount};
    }
    if (file.points) {
      const {cloud, total} = file.points;
      const entity = createPointCloudEntity(app, cloud, new pc.Color(0.84, 0.9, 1), file.filename, 0);
      layer.root.addChild(entity);
      layer.pointEntity=entity;
      layer.points = entity.render!.meshInstances[0].material as PointCloudMaterial;
      layer.bounds = new pc.BoundingBox();
      layer.bounds.setMinMax(cloud.min, cloud.max);
      this.refreshSections();
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
      layer.model = model;
      this.refreshSections();
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
    layer.vector?.destroy();
    layer.copc?.destroy();
    layer.root.destroy();
    layer.points?.destroy();
    if (layer.environmentAsset) {
      layer.environmentAsset.unload();
      this.scene.app.assets.remove(layer.environmentAsset);
    }
    if (layer.asset && ![...this.layers.values()].some(other=>other!==layer && other.asset===layer.asset)) {
      layer.asset.unload();
      this.scene.app.assets.remove(layer.asset);
    }
    this.layers.delete(id);
    this.refreshSections();
    if (!this.layers.size) this.framedModel = false;
  }
  visible(id: number, value: boolean) {
    const layer = this.layers.get(id);
    if (layer) { layer.root.enabled = value; this.refreshSections(); }
  }
  setPointSize(id:number, pixels:number) {
    const layer=this.layers.get(id);
    layer?.points?.setParameter('pointPixels',pixels);
    layer?.copc?.setPointSize(pixels);
  }
  setVectorOverlay(id:number, enabled:boolean) {
    this.layers.get(id)?.vector?.setOverlay(enabled ? this.vectorOverlay.id : undefined);
  }
  replacePoints(id:number, points: NonNullable<ModelFile['points']>, pixels:number) {
    const layer=this.layers.get(id);
    if (!layer?.pointEntity) return;
    layer.file={...layer.file,points};
    const next=createPointCloudEntity(this.scene.app,points.cloud,new pc.Color(.84,.9,1),'LAS',pixels);
    layer.root.addChild(next);
    layer.pointEntity.destroy();
    layer.points?.destroy();
    layer.pointEntity=next;
    layer.points=next.render!.meshInstances[0].material as PointCloudMaterial;
    this.refreshSections();
  }
  useCopc(id:number, data:NonNullable<ModelFile['copc']>, report:(message:string)=>void) {
    const layer=this.layers.get(id);
    if (!layer) return;
    layer.file={...layer.file,copc:data};
    layer.copc=new CopcLayer(data,layer.root,this.scene.app,material=>applySections(material,[[...this.sceneSections,...layer.sections]]),report,()=>{
      if (layer.pointEntity) {
        layer.pointEntity.destroy();
        layer.pointEntity=undefined;
        layer.points?.destroy();
        layer.points=undefined;
      }
    });
  }
  async showEnvironment(id: number, file: ModelFile, visible: boolean) {
    const layer=this.layers.get(id);
    if (!layer) return;
    layer.environmentVisible=visible;
    if (layer.environment) { this.refreshSections(); return; }
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
      this.refreshSections();
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
    if (layer) this.refreshSections();
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
      if (layer) this.refreshSections();
      changed(value);
    });
  }
  private attachGizmo(root: pc.Entity | undefined, mode: string, changed: (value: TransformParameters) => void) {
    this.clearModelTools();
    this.gizmo?.destroy();
    this.gizmo = undefined;
    this.dragging = this.annotationDragging;
    if (!root || !mode) return;
    this.setAnnotationHandle(undefined);
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
          if (camera.zoom(d, width, this.scene.camera.camera!.nearClip * 2)) this.notifyWorldLimit();
        },
      },
    });
    this.canvas.focus();
  }
  annotationScreen(point: XYZ) {
    const position = new pc.Vec3(...point);
    const camera = this.scene.camera;
    const comp = camera.camera!;
    if (position.clone().sub(camera.getPosition()).dot(camera.forward) <= comp.nearClip) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.canvas.clientWidth;
    const h = rect.height || this.canvas.clientHeight;
    const vp = new pc.Mat4().mul2(comp.projectionMatrix, comp.viewMatrix);
    const clip = vp.transformVec4(new pc.Vec4(position.x, position.y, position.z, 1));
    if (clip.w <= 1e-6) return;
    const x = (clip.x / clip.w + 1) * 0.5 * w;
    const y = (1 - clip.y / clip.w) * 0.5 * h;
    return new pc.Vec3(x, y, clip.z / clip.w);
  }

  consumeAnnotationInteraction() {
    const active = this.annotationDragging || this.annotationHovered || this.annotationInteracted;
    this.annotationInteracted = false;
    return active;
  }

  setAnnotationHandle(point?: XYZ, onMove?: (world: XYZ) => void) {
    this.annotationMove = point ? onMove : undefined;
    if (!point) {
      this.annotationGizmo?.detach();
      this.annotationHovered = false;
      this.annotationInteracted = false;
      if (this.annotationDragging) {
        this.annotationDragging = false;
        this.dragging = false;
      }
      return;
    }
    if (!this.annotationGizmo) {
      const overlay =
        this.scene.app.scene.layers.getLayerByName('Viewer annotation gizmo') ??
        pc.TranslateGizmo.createLayer(this.scene.app, 'Viewer annotation gizmo');
      const gizmo = (this.annotationGizmo = new pc.TranslateGizmo(this.scene.camera.camera!, overlay));
      gizmo.mouseButtons[1] = gizmo.mouseButtons[2] = false;
      gizmo.axisGap = 0.08;
      gizmo.axisLineLength = 0.72;
      gizmo.axisPlaneSize = 0.14;
      gizmo.axisPlaneGap = 0.22;
      gizmo.flipPlanes = true;
      gizmo.on(pc.Gizmo.EVENT_POINTERMOVE, (_x: number, _y: number, mesh: unknown) => {
        this.annotationHovered = Boolean(mesh);
      });
      gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => {
        this.annotationDragging = true;
        this.annotationInteracted = true;
        this.dragging = true;
        this.navigation?.clear();
      });
      gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => {
        const pos = this.annotationNode.getPosition();
        this.annotationMove?.([pos.x, pos.y, pos.z]);
      });
      gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
        this.annotationDragging = false;
        this.dragging = false;
      });
    }
    if (!this.annotationDragging) {
      this.annotationNode.setPosition(point[0], point[1], point[2]);
      if (!this.annotationGizmo.nodes.includes(this.annotationNode)) {
        this.annotationGizmo.attach([this.annotationNode]);
      }
    }
  }

  annotationPosition(id:number, point:XYZ, toLocal=false): XYZ | undefined {
    const layer=this.layers.get(id);
    if (!layer) return;
    const matrix=layer.root.getWorldTransform();
    const p=(toLocal ? matrix.clone().invert() : matrix).transformPoint(new pc.Vec3(...point));
    return [p.x,p.y,p.z];
  }
  annotationPick(clientX: number, clientY: number): Promise<{ id: number; point: XYZ; screen: { x: number; y: number } } | undefined> {
    const task = this.annotationPickQueue.then(() => this.runAnnotationPick(clientX, clientY));
    this.annotationPickQueue = task.catch(() => undefined);
    return task;
  }

  private async runAnnotationPick(clientX: number, clientY: number): Promise<{ id: number; point: XYZ; screen: { x: number; y: number } } | undefined> {
    if (this.closed) return;
    if (![...this.layers.values()].some(layer => layer.root.enabled && (layer.asset || (layer.environmentVisible && layer.environmentAsset)))) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (rect.width <= 0 || rect.height <= 0) return;
    const px = (clientX - rect.left) * w / rect.width;
    const py = (clientY - rect.top) * h / rect.height;
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const app = this.scene.app;
    const world = app.scene.layers.getLayerById(pc.LAYERID_WORLD)!;
    const picker = this.annotationPicker ??= new pc.Picker(app, w, h, true);
    if (picker.width !== w || picker.height !== h) picker.resize(w, h);
    picker.prepare(this.scene.camera.camera!, app.scene, [world]);
    const matchLayer = (selected: unknown[]) => {
      const component = selected.find(item => item instanceof pc.GSplatComponent);
      if (!component) return;
      return [...this.layers].find(([, layer]) => layer.model?.gsplat === component || layer.environment?.gsplat === component);
    };
    const pickAt = async (x: number, y: number, exact: boolean) => {
      const entry = matchLayer(await picker.getSelectionAsync(x, y, 1, 1));
      if (!entry) return;
      const hit = await picker.getWorldPointAsync(x, y);
      if (!hit || ![hit.x, hit.y, hit.z].every(Number.isFinite)) return;
      const point = this.annotationPosition(entry[0], [hit.x, hit.y, hit.z], true);
      if (point) {
        const screen = exact
          ? { x: clientX - rect.left, y: clientY - rect.top }
          : { x: (Math.floor(x) + 0.5) * rect.width / w, y: (Math.floor(y) + 0.5) * rect.height / h };
        return { id: entry[0], point, screen };
      }
    };
    const direct = await pickAt(px, py, true);
    if (direct) return direct;
    const radius = 3;
    const area = await picker.getSelectionAsync(Math.max(0, px - radius), Math.max(0, py - radius), radius * 2 + 1, radius * 2 + 1);
    if (!matchLayer(area)) return;
    const offsets: [number, number][] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx || dy) offsets.push([dx, dy]);
      }
    }
    offsets.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
    for (const [dx, dy] of offsets) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const nearby = await pickAt(x, y, false);
      if (nearby) return nearby;
    }
  }

  projection(ortho: boolean) {
    this.camera?.setProjection(ortho);
  }
  initialSectionBox(id: number): TransformParameters {
    const layer = this.layers.get(id);
    const bounds = layer?.bounds && new pc.BoundingBox();
    if (bounds && layer?.bounds) bounds.setFromTransformedAabb(layer.bounds,layer.root.getWorldTransform());
    const c = bounds?.center ?? this.camera?.observationCenter ?? pc.Vec3.ZERO;
    const size = bounds ? 0 : this.viewportSectionSize(c,'box');
    return { translation: [c.x, c.y, c.z], rotation_degrees: [0,0,0],
      scale: bounds ? [bounds.halfExtents.x, bounds.halfExtents.y, bounds.halfExtents.z].map(v=>Math.max(0.1,2*v)) as XYZ : [size, size, size] };
  }
  editBoxNode(box: TransformParameters) {
    this.boxNode.setLocalPosition(...box.translation);
    this.boxNode.setLocalEulerAngles(...box.rotation_degrees);
    this.boxNode.setLocalScale(...box.scale);
  }
  setSections(id: number, sections: ViewerSection[]) {
    const layer = this.layers.get(id);
    if (!layer && id !== 0) return;
    if (this.axisLayer===id && this.hoveredPlane && (!this.hoveredPlane.boundary || !sections.includes(this.hoveredPlane))) this.endPlaneDrag();
    const lines = sections.filter(s=>s.boundary && s.axis==='box').flatMap(boundaryLines);
    if (layer) { layer.sections=sections; layer.lines=lines; }
    else { this.sceneSections=sections; this.sceneLines=lines; }
    this.refreshSections();
  }
  async duplicate(sourceId: number, id: number, report: (message:string)=>void) {
    const source = this.layers.get(sourceId)!;
    if (!source.asset || !source.model) {
      await this.add(id, source.file, report);
      return;
    }
    const layer = new Layer();
    layer.file = source.file;
    layer.asset = source.asset;
    layer.bounds = source.bounds;
    this.layers.set(id, layer);
    this.scene.app.root.addChild(layer.root);
    layer.model = new pc.Entity();
    layer.root.addChild(layer.model);
    layer.model.addComponent('gsplat',{asset:layer.asset});
    layer.model.gsplat!.lodBaseDistance = source.model.gsplat!.lodBaseDistance;
    this.refreshSections();
  }
  private refreshSections() {
    const groups = new Map<string,{node:pc.Entity; rules:ViewerSection[][]}>();
    for (const layer of this.layers.values()) {
      if (!layer.root.enabled) continue;
      if (layer.points) applySections(layer.points,[[...this.sceneSections,...layer.sections]]);
      layer.copc?.updateClip();
      const matrix = layer.root.getWorldTransform();
      const collect = (node:pc.Entity, source:string) => {
        const key = source + ':' + matrix.data.join(',');
        const existing = groups.get(key);
        node.enabled = !existing;
        if (existing) existing.rules.push(layer.sections);
        else groups.set(key,{node,rules:[layer.sections]});
      };
      if (layer.model) collect(layer.model,'model'+layer.asset!.id);
      if (layer.environment) {
        if (layer.environmentVisible) collect(layer.environment,layer.file.environment!.url);
        else layer.environment.enabled=false;
      }
    }
    for (const group of groups.values()) applySections(group.node.gsplat!,group.rules.map(local=>[...this.sceneSections,...local]));
  }
  destroy() {
    this.closed = true;
    this.backdropRequest?.abort();
    this.releaseBackdrop?.();
    this.panPicker?.destroy();
    this.annotationPicker?.destroy();
    this.mapRequest?.abort();
    this.map?.destroy();
    this.inputs.abort();
    this.clearFaceHandles();
    this.labels.destroy();
    this.clearModelTools();
    this.annotationGizmo?.destroy();
    this.annotationNode.destroy();
    this.gizmo?.destroy();
    this.navigation?.destroy();
    for (const id of this.layers.keys()) this.removeLayer(id);
    this.scene.destroy();
  }
}
