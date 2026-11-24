import * as pc from 'playcanvas';
import earcut from 'earcut';
import { geographicToScene,type GeoOrigin } from './viewer-origin';
import type { VectorData } from './vector-data';
export type GroundHeight=(lon:number,lat:number)=>number;

export class VectorLayer {
  readonly root=new pc.Entity('矢量图层');
  readonly bounds=new pc.BoundingBox();
  private draw?:pc.Entity;
  private overlayLayer?:number;
  setOverlay(layerId?:number){
    this.overlayLayer=layerId;
    for(const material of this.materials) material.depthTest=layerId===undefined;
    for(const child of this.draw?.children??[]) {
      (child as pc.Entity).render!.layers=[layerId??pc.LAYERID_WORLD];
    }
  }
  private materials:pc.Material[]=[];
  private textures=new Map<Blob,pc.Texture>();
  private shapes;
  constructor(private app:pc.Application,data:VectorData,base:GeoOrigin){
    const project=geographicToScene(base);
    this.shapes=data.features.flatMap(f=>f.shapes.map(shape=>({...shape,vertices:shape.rings.map(r=>r.map(p=>project(p)))})));
  }
  get usesTerrain(){return this.shapes.some(s=>s.mode!=='绝对高度');}
  async loadIcons(){
    for(const blob of new Set(this.shapes.map(s=>s.icon))){
      if(!blob)continue;
      const bitmap=await createImageBitmap(blob);
      const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap,0,0);bitmap.close();
      const texture=new pc.Texture(this.app.graphicsDevice,{mipmaps:false,flipY:false,name:"vector-icon-"+this.textures.size});
      texture.setSource(canvas);this.textures.set(blob,texture);
    }
  }
  rebuild(ground:GroundHeight){
    const groups=new Map<string,{positions:number[];indices:number[];type:number;color:string;texture?:pc.Texture}>();
    const min=new pc.Vec3(Infinity,Infinity,Infinity),max=new pc.Vec3(-Infinity,-Infinity,-Infinity);
    for(const shape of this.shapes){
      const rings=shape.vertices.map((r,i)=>r.map(([x,y,z],j)=>{
        const [lon,lat,h]=shape.rings[i][j];
        const v=new pc.Vec3(x,y,shape.mode==='绝对高度'?z:ground(lon,lat)+(shape.mode==='相对地面'?h:0));
        min.min(v);max.max(v);return v;
      }));
      const vertices=rings.flat();
      const batch=(type:number,color:string,indices:number[])=>{
        const texture=shape.icon&&type===pc.PRIMITIVE_POINTS?this.textures.get(shape.icon):undefined;
        const key=[type,color,texture?.name].join('/');
        let g=groups.get(key);
        if(!g){g={type,color,positions:[],indices:[],texture};groups.set(key,g);}
        const offset=g.positions.length/3;
        for(const v of vertices)g.positions.push(v.x,v.y,v.z);
        for(const idx of indices)g.indices.push(offset+idx);
      };
      if(shape.kind==='Point'){batch(pc.PRIMITIVE_POINTS,shape.color,vertices.map((_,i)=>i));continue;}
      let offset=0;
      const edges:number[]=[],holes:number[]=[];
      for(const ring of rings){
        if(offset)holes.push(offset);
        for(let i=1;i<ring.length;i++)edges.push(offset+i-1,offset+i);
        if(shape.kind==='Polygon'&&!ring[0].equals(ring[ring.length-1]))edges.push(offset+ring.length-1,offset);
        offset+=ring.length;
      }
      batch(pc.PRIMITIVE_LINES,shape.color,edges);
      if(shape.kind==='Polygon'&&!shape.fill.endsWith('00'))
        batch(pc.PRIMITIVE_TRIANGLES,shape.fill,earcut(vertices.flatMap(v=>[v.x,v.y]),holes));
    }
    this.draw?.destroy();this.materials.forEach(m=>m.destroy());this.materials=[];
    this.draw=new pc.Entity();this.root.addChild(this.draw);
    for(const g of groups.values()){
      const mesh=new pc.Mesh(this.app.graphicsDevice);
      mesh.setPositions(g.positions);mesh.setIndices(g.indices);mesh.update(g.type);
      const mat=new pc.ShaderMaterial({uniqueName:'VectorOverlay'+(g.texture?'Icon':'Color'),attributes:{aPosition:pc.SEMANTIC_POSITION},
        vertexGLSL:'attribute vec3 aPosition; uniform mat4 matrix_model; uniform mat4 matrix_viewProjection; uniform float markerSize; void main(){gl_Position=matrix_viewProjection*matrix_model*vec4(aPosition,1.0); gl_Position.z-=0.000002*gl_Position.w; gl_PointSize=markerSize;}',
        fragmentGLSL:'precision highp float; uniform vec4 tint; '+(g.texture?'uniform sampler2D icon;':'')+'void main(){gl_FragColor=tint'+(g.texture?'*texture2D(icon,gl_PointCoord)':'')+'; if(gl_FragColor.a<0.01)discard;}'});
      mat.cull=pc.CULLFACE_NONE;mat.depthWrite=false;mat.blendType=pc.BLEND_NORMAL;
      mat.depthTest=this.overlayLayer===undefined;
      mat.setParameter('tint',new Float32Array([1,3,5,7].map(i=>parseInt(g.color.slice(i,i+2),16)/255)));
      mat.setParameter('markerSize',g.texture?24:8);if(g.texture)mat.setParameter('icon',g.texture);
      this.materials.push(mat);
      const child=new pc.Entity();child.addComponent('render',{layers:[this.overlayLayer??pc.LAYERID_WORLD],meshInstances:[new pc.MeshInstance(mesh,mat)]});this.draw.addChild(child);
    }
    this.bounds.setMinMax(min,max);
  }
  destroy(){this.root.destroy();this.materials.forEach(m=>m.destroy());this.textures.forEach(t=>t.destroy());}
}
