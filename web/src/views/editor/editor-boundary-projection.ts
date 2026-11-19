import type { XYZ } from '../../coordinate-math';

export function projectVisiblePoint(point: XYZ, depth: number, nearClip: number,
  project: (point: XYZ) => { x: number; y: number }): { x: number; y: number } | null {
  if (!Number.isFinite(depth) || !Number.isFinite(nearClip) || depth < nearClip) return null;
  const screen = project(point);
  return Number.isFinite(screen.x) && Number.isFinite(screen.y) ? { x: screen.x, y: screen.y } : null;
}

export function clipSegmentToNearPlane(a: XYZ, b: XYZ, depthA: number, depthB: number,
  nearClip: number): [XYZ, XYZ] | null {
  if (![depthA, depthB, nearClip].every(Number.isFinite) || depthA < nearClip && depthB < nearClip) return null;
  if (depthA >= nearClip && depthB >= nearClip) return [a, b];
  const t = (nearClip - depthA) / (depthB - depthA);
  const crossing = a.map((value, axis) => value + t * (b[axis] - value)) as XYZ;
  return depthA < nearClip ? [crossing, b] : [a, crossing];
}

export function projectedSegmentPoint(a: [number, number], b: [number, number], pointer: [number, number],
  project: (point: [number, number]) => [number, number], maxDistance: number) {
  const sa = project(a), sb = project(b);
  if (![...sa, ...sb, ...pointer].every(Number.isFinite)) return null;
  const dx = sb[0] - sa[0], dy = sb[1] - sa[1], length = dx * dx + dy * dy;
  if (!length) return null;
  const u = Math.max(0, Math.min(1, ((pointer[0] - sa[0]) * dx + (pointer[1] - sa[1]) * dy) / length));
  if (Math.hypot(pointer[0] - sa[0] - u * dx, pointer[1] - sa[1] - u * dy) >= maxDistance) return null;
  const axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1;
  const target: [number, number] = [sa[0] + u * dx, sa[1] + u * dy];
  let low = 0, high = 1;
  let t = u === 0 || u === 1 ? u : 0.5;
  for (let step = 0; step < 48; step++) {
    const point: [number, number] = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const screen = project(point);
    if (!screen.every(Number.isFinite)) return null;
    if (Math.hypot(screen[0] - target[0], screen[1] - target[1]) <= 0.001) {
      const distance = Math.hypot(pointer[0] - screen[0], pointer[1] - screen[1]);
      return distance < maxDistance ? { point, screen, distance } : null;
    }
    if ((screen[axis] < target[axis]) === (sb[axis] > sa[axis])) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return null;
}
