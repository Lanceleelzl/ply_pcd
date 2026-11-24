import { unzipSync } from 'fflate';
import proj4 from 'proj4';
import { parseDbf, parseShp } from 'shpjs';
import { definition } from './viewer-origin';
import type { XYZ } from '../../coordinate-math';

export type HeightMode = '贴地'|'相对地面'|'绝对高度';
export interface Shape {
  kind:'Point'|'LineString'|'Polygon';
  rings:XYZ[][];
  mode:HeightMode;
  color:string;
  fill:string;
  icon?:Blob;
}
export interface VectorData {
  name:string; crs:string; format:string;
  features:{name:string; attributes:Record<string,unknown>; shapes:Shape[]}[];
}
const fallback='#56d9ffff';
function coordinate(values:number[]):XYZ {
  if(values.length<2)throw Error('矢量坐标缺少经纬度');
  const [lon,lat,z=0]=values;
  if (![lon,lat,z].every(Number.isFinite)||Math.abs(lon)>180||Math.abs(lat)>90) throw Error('矢量坐标无效，请检查源坐标系');
  return [lon,lat,z];
}
function kml(path:string, files:Map<string,Blob>, xml:string, name:string, templateXml?:string):VectorData {
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.querySelector('parsererror')) throw Error('KML XML 格式错误');
  const all=(e:Document|Element,tag:string)=>Array.from(e.getElementsByTagNameNS('*',tag));
  const value=(e:Element|undefined,tag:string)=>e && all(e,tag)[0]?.textContent?.trim();
  const styles=new Map(Array.from(doc.querySelectorAll('[id]')).map(e=>[e.id,e]));
  const data:VectorData={name,format:/\.kmz$/i.test(name)?'KMZ':'KML',crs:'WGS 84',features:[]};
  const wpNamespace=Array.from(doc.getElementsByTagNameNS('*','index')).find(e=>e.namespaceURI?.startsWith('http://www.dji.com/wpmz/') || e.namespaceURI?.startsWith('https://www.dji.com/wpmz/'))?.namespaceURI;
  const wp=(e:Element|Document,tag:string)=>wpNamespace ? e.getElementsByTagNameNS(wpNamespace,tag)[0]?.textContent.trim() : undefined;
  const refPoint=wp(doc,'takeOffRefPoint') || (templateXml && wp(new DOMParser().parseFromString(templateXml,'application/xml'),'takeOffRefPoint'));
  const routes=new Map<Element,{index:number;point:XYZ;mode:HeightMode}[]>();
  for(const pm of all(doc,'Placemark')){
    const shapes:Shape[]=[];
    let style=styles.get(value(pm,'styleUrl')?.slice(1)??'');
    if(style?.localName==='StyleMap') style=styles.get(value(all(style,'Pair').find(p=>value(p,'key')==='normal'),'styleUrl')?.slice(1)??'');
    const local=all(pm,'Style')[0];
    const styleValue=(group:string,key:string)=>value(local&&all(local,group)[0],key)??value(style&&all(style,group)[0],key);
    function color(group:string,def:string){
      const c=styleValue(group,'color');
      return c && /^[a-f\d]{8}$/i.test(c)?'#'+c.slice(6)+c.slice(4,6)+c.slice(2,4)+c.slice(0,2):def;
    }
    for(const kind of ['Point','LineString','Polygon'] as const) for(const geom of all(pm,kind)) {
      const altitude=value(geom,'altitudeMode');
      let mode:HeightMode=altitude==='absolute'?'绝对高度':altitude==='relativeToGround'?'相对地面':'贴地';
      const rings=all(geom,'coordinates').map(e=>e.textContent.trim().split(/\s+/).map(t=>coordinate(t.split(',').map(n=>n.trim()===''?NaN:Number(n)))));
      if(!rings.length || rings.some(r=>r.length<(kind==='Polygon'?3:kind==='Point'?1:2))) throw Error('KML 几何缺少有效顶点');
      const indexText=wp(pm,'index'), folder=pm.parentElement;
      if(kind==='Point' && folder?.localName==='Folder' && indexText!==undefined) {
        const execution=wp(folder,'executeHeightMode');
        const heightMode=execution ?? wp(folder,'heightMode');
        const useGlobal=!execution && wp(pm,'useGlobalHeight')==='1';
        let raw=execution ? wp(pm,'executeHeight') : useGlobal ? wp(folder,'globalHeight') : wp(pm,'height');
        if(!execution && heightMode==='EGM96' && !useGlobal && wp(pm,'ellipsoidHeight')) raw=wp(pm,'ellipsoidHeight');
        let height=Number(raw);
        if(!raw || !Number.isFinite(height))throw Error('航点 '+indexText+' 缺少有效高度');
        mode='绝对高度';
        if(heightMode==='relativeToStartPoint'){
          const originHeight=refPoint?.split(',')[2]?.trim();
          if(!originHeight || !Number.isFinite(Number(originHeight)))throw Error('相对起飞点航线缺少参考起飞点高程');
          height+=Number(originHeight);
        }else if(heightMode==='realTimeFollowSurface'||heightMode==='aboveGroundLevel') mode='相对地面';
        else if(heightMode!=='WGS84' && heightMode!=='EGM96')throw Error('无法识别航线高度模式：'+heightMode);
        const index=Number(indexText);
        if(!indexText || !Number.isInteger(index) || index<0)throw Error('无效航点序号');
        rings[0][0][2]=height;
        const points=routes.get(folder)??[];
        points.push({index,point:rings[0][0],mode});
        routes.set(folder,points);
      }
      const href=styleValue('IconStyle','href');
      const iconPath=href && decodeURIComponent(new URL(href,new URL(path,'https://archive.local/')).pathname.slice(1));
      shapes.push({kind,rings,mode,color:color(kind==='Point'?'IconStyle':'LineStyle',iconPath?'#ffffffff':fallback),
        fill:styleValue('PolyStyle','fill')==='0'?'#00000000':color('PolyStyle','#56d9ff55'),icon:iconPath?files.get(iconPath):undefined});
    }
    const attributes:Record<string,string>={};
    for(const e of [...all(pm,'Data'),...all(pm,'SimpleData')]) attributes[e.getAttribute('name')??'']=value(e,'value')??e.textContent;
    if(shapes.length)data.features.push({name:value(pm,'name')??'',attributes,shapes});
  }
  for(const [folder,points] of routes){
    if(points.length<2)continue;
    points.sort((a,b)=>a.index-b.index);
    const id=wp(folder,'waylineId')??wp(folder,'templateId')??routes.size;
    data.features.push({name:'航线 '+id,attributes:{航点数:points.length},shapes:[{
      kind:'LineString',rings:[points.map(p=>p.point)],mode:points[0].mode,color:'#ffcc45ff',fill:'#00000000'
    }]});
  }
  return data;
}
export async function readVectors(input:File[], requestCrs:(name:string)=>string|null, paths?:string[]):Promise<VectorData[]> {
  const files=new Map<string,Blob>();
  input.forEach((f,i)=>files.set(paths?.[i]||f.webkitRelativePath||f.name,f));
  const result:VectorData[]=[];
  for(const [path,file] of [...files]){
    if(/\.(kmz|zip)$/i.test(path)){
      const entries=unzipSync(new Uint8Array(await file.arrayBuffer()),{filter:e=>!e.name.startsWith('__MACOSX/') && /\.(kml|wpml|shp|dbf|prj|cpg|png|jpe?g|webp)$/i.test(e.name)});
      const packed=new Map(Object.entries(entries).map(([p,b])=>[p,new Blob([new Uint8Array(b)])]));
      if(/\.kmz$/i.test(path)){
        const main=[...packed.keys()].find(p=>/^doc\.kml$/i.test(p))??[...packed.keys()].find(p=>/\.kml$/i.test(p));
        const execution=[...packed.keys()].find(p=>/(?:^|\/)wpmz\/waylines\.wpml$/i.test(p));
        const source=execution??main;
        if(!source)throw Error('KMZ 缺少主 KML');
        const template=execution && main ? await packed.get(main)!.text() : undefined;
        result.push(kml(source,packed,await packed.get(source)!.text(),path,template));
      }else for(const [p,b] of packed) files.set(path+'/'+p,b);
    }else if(/\.kml$/i.test(path)) result.push(kml(path,files,await file.text(),path));
  }
  const lower=new Map([...files].map(([p,b])=>[p.toLowerCase(),b]));
  for(const [path,file] of files){
    if(!/\.shp$/i.test(path))continue;
    const stem=path.slice(0,-4).toLowerCase();
    const prj=(await lower.get(stem+'.prj')?.text())?.trim()||requestCrs(path);
    if(!prj)throw Error('缺少源坐标系，已取消导入');
    const code=/^(?:EPSG:\s*)?(\d+)$/i.exec(prj.trim());
    const project=proj4(code?definition(Number(code[1])):prj,'EPSG:4326');
    const point=(v:number[])=>coordinate([...project.forward(v.slice(0,2)),v[2]??0]);
    const data:VectorData={name:path.split('/').pop()!,format:'SHP',crs:code?'EPSG:'+code[1]:prj,features:[]};
    const dbf=lower.get(stem+'.dbf');
    const cpg=(await lower.get(stem+'.cpg')?.text())?.trim();
    const encoding=cpg==='65001'?'utf-8':cpg==='936'?'gbk':cpg;
    const attrs=dbf?parseDbf(await dbf.arrayBuffer(),encoding):[];
    parseShp(await file.arrayBuffer()).forEach((g,i)=>{
      if(!g)return;
      const shapes:Shape[]=[];
      function add(kind:Shape['kind'],rings:number[][][]){
        if(!rings[0]?.length)return;
        shapes.push({kind,rings:rings.map(r=>r.map(point)),mode:rings[0][0].length>2?'绝对高度':'贴地',color:fallback,fill:'#56d9ff55'});
      }
      switch(g.type){
        case 'Point': add('Point',[[g.coordinates]]);break;
        case 'MultiPoint':add('Point',[g.coordinates]);break;
        case 'LineString':add('LineString',[g.coordinates]);break;
        case 'MultiLineString':g.coordinates.forEach(r=>add('LineString',[r]));break;
        case 'Polygon':add('Polygon',g.coordinates);break;
        case 'MultiPolygon':g.coordinates.forEach(r=>add('Polygon',r));break;
      }
      const attributes=attrs[i]??{};
      if(shapes.length)data.features.push({name:String(attributes.NAME??attributes.name??attributes['名称']??''),attributes,shapes});
    });
    result.push(data);
  }
  if(!result.length||result.some(d=>!d.features.length))throw Error('未找到可显示的点、线或面');
  return result;
}
