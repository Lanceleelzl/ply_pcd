import * as pc from 'playcanvas';
import { createPointCloudEntity, type PointCloudMaterial } from '../../point-cloud';
import type { LocalCopc } from '../../views/viewer/local-copc';

type Node = LocalCopc['nodes'][number];
export class CopcLayer {
  private worker = new Worker(new URL('../../views/viewer/copc.worker.ts',import.meta.url),{type:'module'});
  private loaded = new Map<string,pc.Entity>();
  private wanted = new Set<string>();
  private pending: Node[] = [];
  private active?: Node;
  private failed = false;
  private pointPixels = 0;
  constructor(private data: LocalCopc, private root: pc.Entity, private app: pc.Application,
    private clip: (material:PointCloudMaterial)=>void, report:(message:string)=>void,
    private onFirstChunk?:()=>void) {
    const fail = (reason:string) => { this.failed=true; report('COPC 分块读取失败：'+reason); };
    this.worker.onerror=e=>fail(e.message);
    this.worker.onmessage=({data:chunk})=>{
      const node=this.active;
      this.active=undefined;
      if (chunk.error) { fail(chunk.error); return; }
      if (node && this.wanted.has(node.id) && this.root.enabled) {
        const entity=createPointCloudEntity(this.app,{...chunk,count:node.record.pointCount,min:node.bounds.getMin(),max:node.bounds.getMax()},
          new pc.Color(.84,.9,1),'COPC',this.pointPixels);
        entity.render!.meshInstances[0].material!.setParameter('pointSpacing',this.data.spacing / 2**node.depth);
        this.root.addChild(entity);
        this.loaded.set(node.id,entity);
        this.onFirstChunk?.();
        this.onFirstChunk=undefined;
        this.clip(entity.render!.meshInstances[0].material as PointCloudMaterial);
      }
      this.next();
    };
  }
  setPointSize(pixels:number) {
    this.pointPixels=pixels;
    for (const entity of this.loaded.values()) entity.render!.meshInstances[0].material!.setParameter('pointPixels',pixels);
  }
  private next() {
    if (this.active || this.failed || !this.root.enabled) return;
    const node=this.pending.shift();
    if (!node) return;
    this.active=node;
    const {file,header,center}=this.data;
    this.worker.postMessage({file,header,center,record:node.record});
  }
  update(camera:pc.CameraComponent) {
    if (!this.root.enabled || this.failed) return;
    const matrix=this.root.getWorldTransform(), sphere=new pc.BoundingSphere();
    const axes=matrix.getScale(), scale=Math.max(axes.x,axes.y,axes.z);
    const height=this.app.graphicsDevice.height, eye=camera.entity.getPosition();
    const candidates=[];
    for (const node of this.data.nodes) {
      matrix.transformPoint(node.bounds.center,sphere.center);
      sphere.radius=node.bounds.halfExtents.length()*scale;
      if (!camera.frustum.containsSphere(sphere)) continue;
      const distance=Math.max(0.01,eye.distance(sphere.center)-sphere.radius);
      const span=camera.projection===pc.PROJECTION_ORTHOGRAPHIC ? camera.orthoHeight*2 : 2*distance*Math.tan(camera.fov*Math.PI/360);
      if (node.depth && this.data.spacing*scale*height/(2**(node.depth-1)*span)<1) continue;
      candidates.push({node,distance});
    }
    candidates.sort((a,b)=>a.node.depth-b.node.depth || a.distance-b.distance);
    this.wanted.clear();
    this.pending=[];
    for (const {node} of candidates) {
      this.wanted.add(node.id);
      if (!this.loaded.has(node.id) && this.active?.id!==node.id) this.pending.push(node);
    }
    for (const [id,entity] of this.loaded) {
      if (this.wanted.has(id)) continue;
      this.dispose(entity);
      this.loaded.delete(id);
    }
    this.next();
  }
  updateClip() {
    for (const entity of this.loaded.values()) this.clip(entity.render!.meshInstances[0].material as PointCloudMaterial);
  }
  private dispose(entity:pc.Entity) {
    const material=entity.render!.meshInstances[0].material;
    entity.destroy();
    material?.destroy();
  }
  destroy() {
    this.worker.terminate();
    for (const entity of this.loaded.values()) this.dispose(entity);
    this.loaded.clear();
  }
}
