import { Bounds, Copc, Key, type Hierarchy } from 'copc';
import { BoundingBox, Vec3 } from 'playcanvas';
import { projectedCrs, projectedWkt } from './local-las';
import type { XYZ } from '../../coordinate-math';
import {readRange,type CopcSource} from './copc-source';

export async function readCopc(file: CopcSource, signal: AbortSignal) {
  const get = async (a: number, b: number) => {
    signal.throwIfAborted();
    return new Uint8Array(await readRange(file,a,b,signal));
  };
  const {header,info,wkt} = await Copc.create(get);
  const center = header.min.map((v,i) => (v + header.max[i])/2) as XYZ;
  function box(min: number[], max: number[]) {
    const bounds = new BoundingBox();
    bounds.setMinMax(new Vec3(min[0]-center[0],min[1]-center[1],min[2]-center[2]),
      new Vec3(max[0]-center[0],max[1]-center[1],max[2]-center[2]));
    return bounds;
  }
  const nodes = [];
  const pages = [info.rootHierarchyPage], visited = new Set<number>();
  for (let page = pages.pop(); page; page = pages.pop()) {
    if (visited.has(page.pageOffset)) throw Error('COPC 层级索引重复');
    visited.add(page.pageOffset);
    const tree = await Copc.loadHierarchyPage(get,page);
    for (const child of Object.values(tree.pages)) if (child) pages.push(child);
    for (const [id, record] of Object.entries(tree.nodes)) {
      if (!record?.pointCount) continue;
      const key = Key.parse(id), bounds = Bounds.stepTo(info.cube,key);
      nodes.push({id,record,depth:key[0],bounds:box(bounds.slice(0,3),bounds.slice(3))});
    }
  }
  if (!nodes.length || nodes.reduce((n,v)=>n+v.record.pointCount,0)!==header.pointCount) throw Error('COPC 索引点数与文件头不一致');
  const slices={slice:(start:number,end:number)=>({
    arrayBuffer:()=>readRange(file,start,end,signal),
    text:async()=>new TextDecoder().decode(await get(start,end))
  })};
  const epsg = projectedWkt(wkt?.trim() ?? '') ?? await projectedCrs(slices,header.headerLength,header.pointDataOffset,header.vlrCount);
  return {file,header,center,nodes,bounds:box(header.min,header.max),spacing:info.spacing,origin:epsg ? {epsg,offset:center} : undefined};
}
export type LocalCopc = Awaited<ReturnType<typeof readCopc>>;
export type ChunkRequest = Pick<LocalCopc,'file'|'header'|'center'> & {record:Hierarchy.Node};

export async function matchCopc(source:File, sidecar:CopcSource, signal:AbortSignal) {
  const indexed=await readCopc(sidecar,signal);
  const h=new DataView(await source.slice(0,375).arrayBuffer());
  if (h.byteLength<227 || h.getUint32(0)!==0x4c415346) throw Error('原始 LAS 文件头无效');
  const count=h.getUint8(25)>=4 && h.getUint16(94,true)>=375 ? Number(h.getBigUint64(247,true)) || h.getUint32(107,true) : h.getUint32(107,true);
  const epsg=await projectedCrs(source,h.getUint16(94,true),h.getUint32(96,true),h.getUint32(100,true));
  if (indexed.header.pointCount!==count || epsg!==indexed.origin?.epsg || [0,1,2].some(i=>
    Math.abs(indexed.header.min[i]-h.getFloat64(187+i*16,true))>indexed.header.scale[i] ||
    Math.abs(indexed.header.max[i]-h.getFloat64(179+i*16,true))>indexed.header.scale[i])) throw Error('点数、范围或坐标系不匹配');
  signal.throwIfAborted();
  return indexed;
}
