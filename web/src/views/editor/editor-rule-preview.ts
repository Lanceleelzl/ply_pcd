import type { XYZ } from '../../coordinate-math';
import type { EditorRule } from '../../api/gaussian-editor-api';

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
