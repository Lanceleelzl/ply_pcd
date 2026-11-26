import proj4 from 'proj4';
import { definition, type GeoOrigin } from './viewer-origin';
import type { XYZ } from '../../coordinate-math';

export function annotationCoordinates(frame: GeoOrigin, crs: string, point: XYZ, toScene: boolean): XYZ {
  const [e,n,z] = frame.offset;
  const source = definition(frame.epsg);
  if (source===crs) return toScene ? [point[0]-e,point[1]-n,point[2]-z] : [point[0]+e,point[1]+n,point[2]+z];
  const projection = proj4(source,crs);
  if (toScene) {
    const [x,y] = projection.inverse([point[0],point[1]]);
    return [x-e,y-n,point[2]-z];
  }
  const [x,y] = projection.forward([point[0]+e,point[1]+n]);
  return [x,y,point[2]+z];
}
