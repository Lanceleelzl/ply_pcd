export const providers = { tianditu: '天地图', wms: '自定义 WMS', wmts: '自定义 WMTS' };
export type Provider = keyof typeof providers;
type Protocol = 'WMS' | 'WMTS';
type Matrix = { id: string; x: number; y: number; resolution: number; width: number; height: number; cols: number; rows: number; limits?: number[] };
export interface RasterLayer {
  id: string; title: string; endpoint: string; protocol: Protocol; version: string; crs: string;
  format: string; style: string; set?: string; matrices?: Matrix[]; template?: boolean;
  bounds?: number[]; global?: boolean;
}
const circumference = 2 * Math.PI * 6378137;
const children = (el: Element, name: string) => Array.from(el.children).filter(c => c.localName === name);
const field = (el: Element, name: string) => children(el, name)[0]?.textContent?.trim() || '';
const find = (el: Element, name: string) => Array.from(el.getElementsByTagNameNS('*', name));
function code(crs: string) {
  if (/CRS:?84$/i.test(crs)) return 'CRS:84';
  return /EPSG.*[:/](3857|4326)$/i.exec(crs)?.[1] || '';
}
function query(endpoint: string, params: Record<string,string>) {
  const url = new URL(endpoint, location.href);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('请输入 HTTP 或 HTTPS 地图服务地址');
  for (const key of [...url.searchParams.keys()]) if (key.toUpperCase() in params) url.searchParams.delete(key);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,value);
  return url.href;
}
export interface ServiceKey { endpoint: string; key: string; parameter: string }
function authorized(url: string, auth?: ServiceKey) {
  if (!auth?.key.trim()) return url;
  const target=new URL(url,location.href);
  if (target.origin===new URL(auth.endpoint,location.href).origin) {
    const parameter=auth.parameter.trim();
    if (!parameter) throw Error('请输入 Key 参数名');
    target.searchParams.set(parameter,auth.key.trim());
  }
  return target.href;
}
export async function readMapService(endpoint: string, protocol: Protocol, signal: AbortSignal, auth?: ServiceKey) {
  if (!endpoint.trim()) throw Error('请输入服务地址');
  const response = await fetch(authorized(query(endpoint,{ SERVICE:protocol, REQUEST:'GetCapabilities' }),auth), {signal,credentials:'omit'});
  if (!response.ok) throw Error('读取地图服务能力失败：HTTP ' + response.status);
  const root = new DOMParser().parseFromString(await response.text(),'application/xml').documentElement;
  const version = root.getAttribute('version') || '';
  const layers: RasterLayer[] = [];
  const href = (el?: Element) => el?.getAttributeNS('http://www.w3.org/1999/xlink','href');
  const address = (value?: string | null) => value ? new URL(value,response.url).href : endpoint;
  if (protocol === 'WMS') {
    const operation = find(root,'GetMap')[0];
    if (!operation) throw Error('服务未声明 WMS GetMap');
    const formats=children(operation,'Format').map(f=>f.textContent?.trim());
    const format=['image/png','image/jpeg'].find(f=>formats.includes(f));
    if (!format) throw Error('WMS 未提供 PNG 或 JPEG');
    const get = find(operation,'Get')[0];
    for (const layer of find(root,'Layer')) {
      const id = field(layer,'Name');
      if (!id) continue;
      const supported: string[] = [];
      for (let el: Element | null=layer; el?.localName==='Layer'; el=el.parentElement)
        for (const child of [...children(el,'CRS'),...children(el,'SRS')]) supported.push(...(child.textContent||'').trim().split(/\s+/));
      const crs = ['3857','CRS:84','4326'].map(c=>supported.find(s=>code(s)===c)).find(Boolean);
      if (crs) layers.push({id,title:field(layer,'Title') || id,endpoint:address(get && href(find(get,'OnlineResource')[0])),version,protocol,crs,format,style:''});
    }
  } else {
    const contents = find(root,'Contents')[0];
    if (!contents) throw Error('服务未声明 WMTS Contents');
    const sets = children(contents,'TileMatrixSet');
    const operation = find(root,'Operation').find(o=>o.getAttribute('name')==='GetTile');
    for (const layer of children(contents,'Layer')) {
      const id = field(layer,'Identifier');
      const links = children(layer,'TileMatrixSetLink');
      const set = links.map(link=>sets.find(s=>field(s,'Identifier')===field(link,'TileMatrixSet'))).find(s=>s && code(field(s,'SupportedCRS')));
      if (!set) continue;
      const crs = field(set,'SupportedCRS');
      const link=links.find(l=>field(l,'TileMatrixSet')===field(set,'Identifier'))!;
      const limits=find(link,'TileMatrixLimits');
      const matrices = children(set,'TileMatrix').filter(m=>!limits.length || limits.some(l=>field(l,'TileMatrix')===field(m,'Identifier'))).map(m=>{
        const origin = field(m,'TopLeftCorner').split(/\s+/).map(Number);
        if (code(crs)==='4326') origin.reverse();
        const limit=limits.find(l=>field(l,'TileMatrix')===field(m,'Identifier'));
        return {id:field(m,'Identifier'), x:origin[0], y:origin[1],
          limits:limit && ['MinTileCol','MinTileRow','MaxTileCol','MaxTileRow'].map(k=>Number(field(limit,k))),
          resolution:Number(field(m,'ScaleDenominator'))*0.00028*(code(crs)==='3857'?1:360/circumference),
          width:Number(field(m,'TileWidth')),height:Number(field(m,'TileHeight')),cols:Number(field(m,'MatrixWidth')),rows:Number(field(m,'MatrixHeight'))};
      }).filter(m=>[m.x,m.y].every(Number.isFinite) && [m.resolution,m.width,m.height,m.cols,m.rows].every(v=>Number.isFinite(v)&&v>0));
      const formats=children(layer,'Format').map(f=>f.textContent?.trim());
      const format=['image/png','image/jpeg'].find(f=>formats.includes(f));
      if (!format || !matrices.length) continue;
      const resource = children(layer,'ResourceURL').find(r=>r.getAttribute('resourceType')==='tile' && r.getAttribute('format')===format);
      const url = resource?.getAttribute('template');
      const style = children(layer,'Style').find(s=>s.getAttribute('isDefault')==='true') || children(layer,'Style')[0];
      layers.push({id,title:field(layer,'Title') || id,protocol,version,crs,format,style:style?field(style,'Identifier'):'',
        set:field(set,'Identifier'),matrices,template:!!url,endpoint:address(url || (operation && href(find(operation,'Get')[0]))).replace(/%7B/ig,'{').replace(/%7D/ig,'}')});
    }
  }
  if (!layers.length) throw Error('未找到可用的 WGS 84 或 Web 墨卡托栅格图层');
  for (const entry of layers) {
    let el: Element | null | undefined=find(root,'Layer').find(l=>(field(l,'Identifier')||field(l,'Name'))===entry.id);
    while (el?.localName==='Layer') {
      const box=children(el,'WGS84BoundingBox')[0], geo=children(el,'EX_GeographicBoundingBox')[0], legacy=children(el,'LatLonBoundingBox')[0];
      if (box) entry.bounds=[field(box,'LowerCorner'),field(box,'UpperCorner')].join(' ').trim().split(/\s+/).map(Number);
      else if (geo) entry.bounds=['westBoundLongitude','southBoundLatitude','eastBoundLongitude','northBoundLatitude'].map(k=>Number(field(geo,k)));
      else if (legacy) entry.bounds=['minx','miny','maxx','maxy'].map(k=>Number(legacy.getAttribute(k)));
      if (entry.bounds) break;
      el=el.parentElement;
    }
    const b=entry.bounds;
    entry.global=!!b && b[0]<=-179.99 && b[2]>=179.99 && b[1]<=-85 && b[3]>=85;
  }
  return layers;
}

// Resample geographic images row by row onto the viewer's Web Mercator texture grid.
export async function paintService(layer: RasterLayer, z: number, x: number, y: number,
  ctx: CanvasRenderingContext2D, dx: number, dy: number, signal: AbortSignal, auth?: ServiceKey) {
  const n = 2**z, projected = code(layer.crs)==='3857';
  const span = (projected ? circumference : 360)/n;
  const west = (x-n/2)*span;
  const northing = (row: number) => projected ? (n/2-y-row/256)*span : Math.atan(Math.sinh(Math.PI*(1-2*(y+row/256)/n)))*180/Math.PI;
  const north=northing(0), south=northing(256);
  async function bitmap(url: string) {
    const response=await fetch(authorized(url,auth),{signal,credentials:'omit'});
    if (!response.ok) throw Error('地图瓦片读取失败：HTTP '+response.status);
    return createImageBitmap(await response.blob());
  }
  if (layer.protocol==='WMS') {
    const v13=layer.version.startsWith('1.3');
    const bbox=v13 && code(layer.crs)==='4326' ? [south,west,north,west+span] : [west,south,west+span,north];
    const img=await bitmap(query(layer.endpoint,{SERVICE:'WMS',VERSION:layer.version,REQUEST:'GetMap',LAYERS:layer.id,STYLES:'',
      FORMAT:layer.format,TRANSPARENT:'TRUE',[v13?'CRS':'SRS']:layer.crs,BBOX:bbox.join(','),WIDTH:'256',HEIGHT:'256'}));
    try {
      if (projected) ctx.drawImage(img,dx,dy,256,256);
      else for(let r=0;r<256;r++) ctx.drawImage(img,0,(north-northing(r))/(north-south)*img.height,img.width,
        (northing(r)-northing(r+1))/(north-south)*img.height,dx,dy+r,256,1);
    } finally { img.close(); }
    return;
  }
  const target=span/256;
  const matrices=layer.matrices!;
  const m=matrices.reduce((a,b)=>Math.abs(Math.log(a.resolution/target))<Math.abs(Math.log(b.resolution/target))?a:b);
  const width=m.width*m.resolution,height=m.height*m.resolution;
  const [minCol,minRow,maxCol,maxRow]=m.limits || [0,0,m.cols-1,m.rows-1];
  const firstCol=Math.max(minCol,Math.floor((west-m.x)/width)), lastCol=Math.min(maxCol,Math.ceil((west+span-m.x)/width)-1);
  const firstRow=Math.max(minRow,Math.floor((m.y-north)/height)), lastRow=Math.min(maxRow,Math.ceil((m.y-south)/height)-1);
  if (firstCol>lastCol || firstRow>lastRow) return;
  if ((lastCol-firstCol+1)*(lastRow-firstRow+1)>64) throw Error('当前视距超出该 WMTS 的层级范围');
  for(let row=firstRow;row<=lastRow;row++) for(let col=firstCol;col<=lastCol;col++) {
    const params={TileMatrixSet:layer.set!,TileMatrix:m.id,TileRow:String(row),TileCol:String(col),Style:layer.style};
    const url=layer.template ? Object.entries(params).reduce((u,[k,v])=>u.replaceAll('{'+k+'}',encodeURIComponent(v)),layer.endpoint)
      : query(layer.endpoint,{SERVICE:'WMTS',VERSION:layer.version,REQUEST:'GetTile',LAYER:layer.id,FORMAT:layer.format,
        ...Object.fromEntries(Object.entries(params).map(([k,v])=>[k.toUpperCase(),v]))});
    const img=await bitmap(url);
    const x0=dx+(m.x+col*width-west)/target, top=m.y-row*height;
    try {
      if (projected) {
        ctx.drawImage(img,x0,dy+(north-top)/target,width/target,height/target);
        continue;
      }
      for(let r=0;r<256;r++){
        const y1=(top-northing(r))/height*img.height, y2=(top-northing(r+1))/height*img.height;
        if(y2>0 && y1<img.height) ctx.drawImage(img,0,y1,img.width,y2-y1,x0,dy+r,width/target,1);
      }
    } finally {img.close();}
  }
}
