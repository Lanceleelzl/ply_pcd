import type { XYZ } from '../../coordinate-math';
import type { EditorRule } from '../../api/gaussian-editor-api';

export function rectangleFromCorners(first: [number, number], second: [number, number]): [number, number][] | null {
  if (![...first, ...second].every(Number.isFinite)) return null;
  const minX = Math.min(first[0], second[0]), maxX = Math.max(first[0], second[0]);
  const minY = Math.min(first[1], second[1]), maxY = Math.max(first[1], second[1]);
  if ((maxX - minX) * (maxY - minY) <= 1e-9) return null;
  return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
}

export function polygonValidationError(points: [number, number][]): string | null {
  if (points.length < 3 || points.length > 256 || points.some(point => point.length !== 2
    || point.some(value => !Number.isFinite(value)))) return '平面边界需要 3～256 个有效顶点';
  const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(points.reduce((area, point, index) => area + cross([0, 0], points[index - 1] ?? points.at(-1)!, point), 0)) <= 1e-9)
    return '平面边界面积为零';
  for (let first = 0; first < points.length; first++) {
    for (let second = first + 2; second < points.length; second++) {
      if (first === 0 && second === points.length - 1) continue;
      const a = points[first], b = points[(first + 1) % points.length];
      const c = points[second], d = points[(second + 1) % points.length];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
        return '平面边界不能自相交';
    }
  }
  return null;
}

export function containsEditorRule(rule: EditorRule, [x, y, z]: XYZ): boolean {
  if (rule.type === 'polygon') {
    let inside = false;
    let previous = rule.points[rule.points.length - 1];
    for (const current of rule.points) {
      const [x1, y1] = previous, [x2, y2] = current;
      const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
      if (Math.abs(cross) <= 1e-9 && x >= Math.min(x1, x2) - 1e-9 && x <= Math.max(x1, x2) + 1e-9
        && y >= Math.min(y1, y2) - 1e-9 && y <= Math.max(y1, y2) + 1e-9) return true;
      if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
      previous = current;
    }
    return inside;
  }
  const dx = x - rule.center[0], dy = y - rule.center[1], dz = z - rule.center[2];
  if (rule.type === 'sphere') return dx * dx + dy * dy + dz * dz <= rule.radius * rule.radius;
  const [w, qx, qy, qz] = rule.rotation;
  const tx = -2 * (qy * dz - qz * dy);
  const ty = -2 * (qz * dx - qx * dz);
  const tz = -2 * (qx * dy - qy * dx);
  const local: XYZ = [dx + w * tx - qy * tz + qz * ty,
    dy + w * ty - qz * tx + qx * tz,
    dz + w * tz - qx * ty + qy * tx];
  return local.every((value, axis) => Math.abs(value) <= rule.size[axis] / 2);
}

export function keepsEditorPoint(rules: EditorRule[], point: XYZ): boolean {
  const keep = rules.filter(rule => rule.action === 'keep');
  if (keep.length && !keep.some(rule => containsEditorRule(rule, point))) return false;
  return !rules.some(rule => rule.action === 'remove' && containsEditorRule(rule, point));
}
