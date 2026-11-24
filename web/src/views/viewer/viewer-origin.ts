import proj4 from 'proj4';
import { wgs84Utm } from '../streaming/geographic-frame';
import type { XYZ } from '../../coordinate-math';

export interface GeoOrigin {
  epsg: number;
  offset: XYZ;
}
export async function readOrigin(files: Map<string, Blob>): Promise<GeoOrigin | undefined> {
  const item = [...files].find(([p]) => /(?:^|\/)lod-meta\.json$|\.lcc2?$/i.test(p)) ?? [...files].find(([p]) => /\.ply$/i.test(p));
  if (!item) return;
  let epsg: number, offset: XYZ;
  if (/\.ply$/i.test(item[0])) {
    const header = (await item[1].slice(0, 131072).text()).split('end_header')[0];
    const values = new Map(
      [...header.matchAll(/^comment\s+(epsg|offset[xyz])\s+([^\s]+)\s*$/gim)].map((m) => [
        m[1].toLowerCase(),
        Number(m[2]),
      ]),
    );
    epsg = Number(values.get('epsg'));
    offset = ['x', 'y', 'z'].map((a) => values.get('offset' + a)) as XYZ;
  } else {
    const meta = JSON.parse(await item[1].text());
    epsg = meta.epsg;
    offset = meta.offset;
  }
  if (
    Number.isInteger(epsg) &&
    Array.isArray(offset) &&
    offset.length === 3 &&
    offset.every(Number.isFinite)
  )
    return { epsg, offset };
}
export function definition(code: number) {
  const zone = code % 100;
  if ((Math.floor(code / 100) === 326 || Math.floor(code / 100) === 327) && zone >= 1 && zone <= 60)
    return `+proj=utm +zone=${zone} ${code >= 32700 ? '+south' : ''} +datum=WGS84 +units=m +no_defs`;
  const key = 'EPSG:' + code;
  if (!proj4.defs(key)) throw new Error('缺少 ' + key + ' 投影定义');
  return key;
}
export function geographicPosition(base: GeoOrigin): number[] {
  return proj4(definition(base.epsg), 'EPSG:4326', base.offset.slice(0, 2));
}
export function convertOrigin(origin: GeoOrigin, epsg: number): GeoOrigin {
  if (origin.epsg === epsg) return origin;
  const [x, y] = proj4(definition(origin.epsg), definition(epsg), origin.offset.slice(0, 2));
  if (![x, y].every(Number.isFinite)) throw Error('坐标转换超出投影范围');
  return { epsg, offset: [x, y, origin.offset[2]] };
}
export function sceneToGeographic(base: GeoOrigin, x: number, y: number) {
  const target = definition(base.epsg === 4326 ? wgs84Utm(base.offset[0], base.offset[1]) : base.epsg);
  const origin = proj4(definition(base.epsg), target, base.offset.slice(0, 2));
  return proj4(target, 'EPSG:4326', [origin[0] + x, origin[1] + y]);
}
export function geographicToScene(base: GeoOrigin) {
  const target = definition(base.epsg === 4326 ? wgs84Utm(base.offset[0],base.offset[1]) : base.epsg);
  const origin = proj4(definition(base.epsg),target,base.offset.slice(0,2));
  const project = proj4('EPSG:4326',target);
  return ([lon,lat,height]:XYZ):XYZ => {
    const [x,y]=project.forward([lon,lat]);
    if(!Number.isFinite(x)||!Number.isFinite(y)) throw Error('矢量坐标超出场景投影范围');
    return [x-origin[0],y-origin[1],height-base.offset[2]];
  };
}
export function sceneOffset(source: GeoOrigin, base: GeoOrigin): XYZ {
  const target = definition(base.epsg === 4326 ? wgs84Utm(base.offset[0], base.offset[1]) : base.epsg);
  const project = (g: GeoOrigin) => proj4(definition(g.epsg), target, g.offset.slice(0, 2));
  const a = project(source),
    b = project(base);
  const offset: XYZ = [a[0] - b[0], a[1] - b[1], source.offset[2] - base.offset[2]];
  if (!offset.every(Number.isFinite)) throw new Error('坐标转换超出投影范围');
  return offset;
}
