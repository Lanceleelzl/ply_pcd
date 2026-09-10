import type { ModelId } from './api/contracts';

export type OriginPlane = 'xoy' | 'xoz' | 'yoz';
export type OriginPlaneState = Record<ModelId, Record<OriginPlane, { visible: boolean; side: number }>>;

export function createOriginPlaneState(): OriginPlaneState {
  return {
    a: { xoy: { visible: false, side: 0 }, xoz: { visible: false, side: 0 }, yoz: { visible: false, side: 0 } },
    b: { xoy: { visible: false, side: 0 }, xoz: { visible: false, side: 0 }, yoz: { visible: false, side: 0 } },
  };
}
