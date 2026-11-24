declare module 'shpjs' {
  type Geometry = {type:'Point';coordinates:number[]} | {type:'MultiPoint'|'LineString';coordinates:number[][]} | {type:'MultiLineString'|'Polygon';coordinates:number[][][]} | {type:'MultiPolygon';coordinates:number[][][][]};
  export function parseShp(data:ArrayBuffer): (Geometry|null)[];
  export function parseDbf(data:ArrayBuffer, encoding?:string): Record<string,unknown>[];
}
declare module 'earcut' {
  export default function earcut(vertices:number[], holes?:number[], dimensions?:number):number[];
}
