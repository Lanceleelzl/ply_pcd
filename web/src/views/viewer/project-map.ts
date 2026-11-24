import * as pc from 'playcanvas';
import { paintService, type Provider, type RasterLayer } from './map-service';
import { sceneToGeographic, sceneOffset, type GeoOrigin } from './viewer-origin';

export interface MapOptions {
  key: string; imagery: boolean; labels: boolean; dem: boolean;
  endpoint: string; keyParameter: string;
  elevationEndpoint?: string; elevationKey?: string; elevationParameter?: string;
  heightOffset: number;
  provider: Provider;
  imageLayer?: RasterLayer;
  labelLayer?: RasterLayer;
  demUrl: string;
  elevationLayer?: RasterLayer;
  encoding?: 'terrarium' | 'terrain-rgb';
}

function surface(size: number, height = size) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true })!;
}

async function paint(url: string, ctx: CanvasRenderingContext2D, x: number, y: number, signal: AbortSignal, source: string, factor = 1, col = 0, row = 0) {
  try {
    const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin' });
    if (!response.ok) throw Error();
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const w = bitmap.width / factor, h = bitmap.height / factor;
      ctx.drawImage(bitmap, col*w, row*h, w, h, x, y, 256, 256);
    } finally { bitmap.close(); }
  } catch {
    signal.throwIfAborted();
    throw Error(source + '瓦片读取失败，请检查服务、网络及授权');
  }
}

function tileUrl(layer: 'img' | 'cia', z: number, x: number, y: number, key: string) {
  const query = new URLSearchParams({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0',
    LAYER: layer, STYLE: 'default', FORMAT: 'tiles', TILEMATRIXSET: 'w', TILEMATRIX: String(z),
    TILECOL: String(x), TILEROW: String(y), tk: key });
  return 'https://t0.tianditu.gov.cn/' + layer + '_w/wmts?' + query;
}

async function paintLayer(options: MapOptions, kind: 'img' | 'cia', z: number, x: number, y: number, ctx: CanvasRenderingContext2D, dx: number, dy: number, signal: AbortSignal) {
  if (options.provider === 'tianditu') return paint(tileUrl(kind,z,x,y,options.key),ctx,dx,dy,signal,'天地图');
  const layer = kind === 'img' ? options.imageLayer : options.labelLayer;
  if (!layer) throw Error('请选择地图图层');
  const tile = surface(256);
  await paintService(layer,z,x,y,tile,0,0,signal,{endpoint:options.endpoint,key:options.key,parameter:options.keyParameter});
  ctx.drawImage(tile.canvas,dx,dy);
}

export async function worldBackdrop(app: pc.Application, base: GeoOrigin, options: MapOptions, signal: AbortSignal) {
  const atlas = surface(512);
  await Promise.all([0,1,2,3].map(i => paintLayer(options,'img',1,i%2,i>>1,atlas,(i%2)*256,(i>>1)*256,signal)));
  signal.throwIfAborted();
  function mercator(x: number, y: number) {
    const [lon, lat] = sceneToGeographic(base,x,y);
    return [(lon+180)/360, (1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2];
  }
  const uv = mercator(0,0), east = mercator(100,0), north = mercator(0,100);
  const texture = new pc.Texture(app.graphicsDevice, {flipY:false, mipmaps:false,
    addressU:pc.ADDRESS_REPEAT, addressV:pc.ADDRESS_CLAMP_TO_EDGE});
  texture.setSource(atlas.canvas);
  const mat = new pc.ShaderMaterial({uniqueName:'ViewerWorldImagery', attributes:{aPosition:pc.SEMANTIC_POSITION},
    vertexGLSL:`attribute vec3 aPosition;
      uniform mat4 matrix_viewInverse;
      uniform mat4 matrix_projection;
      varying vec3 start;
      varying vec3 ray;
      void main(){ vec2 xy=aPosition.xy; mat4 inv=inverse(matrix_projection);
        vec4 a=inv*vec4(xy,-1.,1.), b=inv*vec4(xy,0.,1.);
        start=(matrix_viewInverse*vec4(a.xyz/a.w,1.)).xyz;
        ray=mat3(matrix_viewInverse)*(b.xyz/b.w-a.xyz/a.w);
        gl_Position=vec4(xy,1.,1.); }`,
    fragmentGLSL:`precision highp float;
      varying vec3 start;
      varying vec3 ray;
      uniform sampler2D worldImage;
      uniform vec2 originUV;
      uniform vec2 eastUV;
      uniform vec2 northUV;
      void main(){ float t=-start.z/ray.z;
        if(abs(ray.z)<1e-12 || t<0.) { gl_FragColor=vec4(.48,.64,.77,1.); return; }
        vec2 p=start.xy+t*ray.xy;
        vec2 uv=originUV+p.x*eastUV+p.y*northUV;
        if(abs(uv.x-originUV.x)>.5 || uv.y<0. || uv.y>1.) { gl_FragColor=vec4(.035,.055,.085,1.); return; }
        gl_FragColor=texture2D(worldImage,uv); }`});
  mat.depthWrite=false; mat.depthFunc=pc.FUNC_LESSEQUAL; mat.cull=pc.CULLFACE_NONE;
  mat.setParameter('worldImage',texture); mat.setParameter('originUV',uv);
  const delta=(v:number[])=>[((v[0]-uv[0]+1.5)%1-.5)/100,(v[1]-uv[1])/100];
  mat.setParameter('eastUV',delta(east)); mat.setParameter('northUV',delta(north));
  const mesh=new pc.Mesh(app.graphicsDevice);
  mesh.setPositions([-1,-1,0,3,-1,0,-1,3,0]); mesh.update();
  const mi=new pc.MeshInstance(mesh,mat); mi.cull=false; mi.pick=false;
  const entity=new pc.Entity('全球影像底图'); entity.addComponent('render',{meshInstances:[mi]});
  app.root.addChild(entity);
  return () => { entity.destroy(); mat.destroy(); texture.destroy(); };
}

export function mapWindow(base: GeoOrigin, view: {x:number; y:number; span:number}, corners: pc.Vec3[]) {
  const [lon,lat] = sceneToGeographic(base,view.x,view.y);
  if (![lon,lat].every(Number.isFinite)) throw Error('项目原点超出投影范围');
  const points = [[lon,lat], ...corners.map(p => sceneToGeographic(base,p.x,p.y))]
    .filter(([x,y])=>Number.isFinite(x) && Number.isFinite(y));
  let z = Math.min(18, Math.max(4, Math.floor(Math.log2(2*40075016.69*Math.cos(lat*Math.PI/180)/Math.max(view.span,1)))));
  for (;; z--) {
    const n=2**z;
    const xs=points.map(([x])=>Math.floor((x+180)/360*n));
    const ys=points.map(([,y])=>Math.floor((1-Math.asinh(Math.tan(Math.max(-85,Math.min(85,y))*Math.PI/180))/Math.PI)/2*n));
    const lo=(v:number[])=>Math.max(0,Math.min(n-1,Math.min(...v)-1));
    const hi=(v:number[])=>Math.max(0,Math.min(n-1,Math.max(...v)+1));
    const left=lo(xs), top=lo(ys), cols=hi(xs)-left+1, rows=hi(ys)-top+1;
    if (cols<=6 && rows<=6) return {z,left,top,cols,rows};
    if (z===4) return {z,left:Math.max(0,Math.min(n-3,xs[0]-1)),top:Math.max(0,Math.min(n-3,ys[0]-1)),cols:3,rows:3};
  }
}
export async function buildProjectMap(app: pc.Application, base: GeoOrigin, config: MapOptions, signal: AbortSignal, window: ReturnType<typeof mapWindow>) {
  const { z, left, top, cols, rows } = window, n = 2 ** z;
  const bounds=config.imagery && config.imageLayer?.bounds;
  const latitudeAt=(row:number)=>Math.atan(Math.sinh(Math.PI*(1-2*row/n)))*180/Math.PI;
  if (bounds && (bounds[0]>(left+cols)/n*360-180 || bounds[2]<left/n*360-180 ||
    bounds[1]>latitudeAt(top) || bounds[3]<latitudeAt(top+rows))) throw Error('当前视口在影像服务覆盖范围之外');
  const imagery = surface(256*cols,256*rows), labels = surface(256*cols,256*rows), dem = surface(256*cols,256*rows);
  for (let j = 0; j < rows; j++) {
    await Promise.all(Array.from({length:cols}, async (_,i) => {
      const x = left + i, y = top + j;
      if (config.imagery) await paintLayer(config,'img',z,x,y,imagery,i*256,j*256,signal);
      if (config.labels) await paintLayer(config,'cia',z,x,y,labels,i*256,j*256,signal);
      const dz = Math.min(15,z), factor = 2 ** (z-dz);
      const terrainTemplate = config.demUrl || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
      if (config.dem) {
        dem.imageSmoothingEnabled=false;
        if (config.elevationLayer) {
          const tile=surface(256);
          tile.imageSmoothingEnabled=false;
          await paintService(config.elevationLayer,z,x,y,tile,0,0,signal,
            {endpoint:config.elevationEndpoint || '',key:config.elevationKey || '',parameter:config.elevationParameter || 'key'});
          dem.drawImage(tile.canvas,i*256,j*256);
        } else await paint(terrainTemplate.replace('{z}',String(dz)).replace('{x}',String(Math.floor(x/factor))).replace('{y}',String(Math.floor(y/factor))),
          dem, i*256, j*256, signal, 'DEM', factor, x%factor, y%factor);
      }
    }));
  }
  signal.throwIfAborted();
  const pixels = config.dem ? dem.getImageData(0, 0, 256*cols, 256*rows).data : undefined;
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  const steps = 96;
  for (let j = 0; j <= steps; j++) for (let i = 0; i <= steps; i++) {
    const u = i / steps, v = j / steps;
    const lng = (left + u*cols) / n * 360 - 180;
    const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2*(top + v*rows)/n))) * 180 / Math.PI;
    const p = (Math.min(rows*256-1,Math.floor(v*rows*256))*cols*256 + Math.min(cols*256-1,Math.floor(u*cols*256)))*4;
    let height=base.offset[2];
    if (pixels && pixels[p+3]) height=config.encoding==='terrain-rgb'
      ? -10000 + (pixels[p]*65536 + pixels[p+1]*256 + pixels[p+2])*0.1
      : pixels[p]*256 + pixels[p+1] + pixels[p+2]/256 - 32768;
    positions.push(...sceneOffset({ epsg: 4326, offset: [lng, latitude, height + config.heightOffset] }, base));
    uv.push(u, 1-v);
    if (i < steps && j < steps) {
      const a = j*(steps+1)+i, b = a+steps+1;
      indices.push(a,b,a+1,a+1,b,b+1);
    }
  }
  const mesh = new pc.Mesh(app.graphicsDevice);
  mesh.setPositions(positions); mesh.setUvs(0, uv); mesh.setIndices(indices); mesh.update();
  const entity = new pc.Entity('地图图层');
  const resources: Array<pc.Texture | pc.Material> = [];
  const nodes = new Map<string, pc.Entity>();
  for (const [kind, canvas] of [['dem', null], ['imagery', imagery], ['labels', labels]] as const) {
    if (!config[kind]) continue;
    const material = new pc.StandardMaterial();
    material.useLighting = false;
    material.emissive.set(0.42,0.48,0.44);
    material.cull = pc.CULLFACE_NONE;
    if (canvas) {
      const texture = new pc.Texture(app.graphicsDevice, { flipY: true, mipmaps: false, addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE });
      texture.setSource(canvas.canvas);
      material.emissive.set(1,1,1); material.emissiveMap = texture;
      material.depthBias = kind === 'labels' ? -3 : -1;
      if (kind === 'labels') {
        material.blendType = pc.BLEND_NORMAL; material.opacityMap = texture; material.opacityMapChannel = 'a';
      }
      resources.push(texture);
    }
    material.update();
    resources.push(material);
    const child = new pc.Entity(kind);
    child.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, material)] });
    entity.addChild(child); nodes.set(kind, child);
  }
  app.root.addChild(entity);
  return { entity, radius: mesh.aabb.center.length() + mesh.aabb.halfExtents.length(),
    groundHeight(lon:number,lat:number) {
      const rad=lat*Math.PI/180;
      const u=((lon+180)/360*n-left)*steps/cols;
      const v=((1-Math.asinh(Math.tan(rad))/Math.PI)/2*n-top)*steps/rows;
      if(u<0 || v<0 || u>steps || v>steps) return config.heightOffset;
      const i=Math.min(steps-1,Math.floor(u)),j=Math.min(steps-1,Math.floor(v));
      const a=j*(steps+1)+i,b=a+steps+1,x=u-i,y=v-j;
      const z=(idx:number)=>positions[idx*3+2];
      return x+y<=1 ? z(a)*(1-x-y)+z(a+1)*x+z(b)*y : z(b+1)*(x+y-1)+z(a+1)*(1-y)+z(b)*(1-x);
    },
    pick(ray: pc.Ray): pc.Vec3 | null {
      if (!entity.enabled || ![...nodes.values()].some(node => node.enabled)) return null;
      const triangle = new pc.Tri(), hit = new pc.Vec3();
      const vertices = [triangle.v0, triangle.v1, triangle.v2];
      let nearest: pc.Vec3 | null = null, best = Infinity;
      for (let i = 0; i < indices.length; i += 3) {
        for (let j = 0; j < 3; j++) {
          const k = indices[i + j] * 3;
          vertices[j].set(positions[k], positions[k + 1], positions[k + 2]);
        }
        if (triangle.intersectsRay(ray, hit)) {
          const distance = hit.distance(ray.origin);
          if (distance < best) { nearest = hit.clone(); best = distance; }
        }
      }
      return nearest;
    },
    visibility(options: MapOptions) {
      for (const kind of ['imagery','labels','dem'] as const) {
        const node = nodes.get(kind);
        if (node) node.enabled = options[kind];
      }
    },
    destroy() { entity.destroy(); resources.forEach(resource => resource.destroy()); } };
}
