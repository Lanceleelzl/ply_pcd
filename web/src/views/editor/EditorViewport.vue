<script setup lang="ts">
import * as pc from 'playcanvas';
import { onUnmounted, ref, watch } from 'vue';
import type { XYZ } from '../../coordinate-math';
import type { EditorDisplayClip, EditorRule, EditorTransform } from '../../api/gaussian-editor-api';
import { loadPreview } from '../../point-cloud';
import { SingleModelEngine } from '../../engine/core/SingleModelEngine';

const props = defineProps<{ previewUrl: string; gaussianUrl?: string | null; filename: string; gaussianLod?: number;
  origin: XYZ; pointCount?: number; lodLabel: string; transform: EditorTransform; largeOriginalBytes?: number;
  largeOriginalCount?: number;
  rules: EditorRule[]; polygonDraft: [number, number][]; editingPolygonIndex?: number | null;
  snappingPolygon?: boolean; editingVolumeIndex?: number | null;
  clip: EditorDisplayClip }>();
const emit = defineEmits<{ pick: [point: XYZ]; notify: [message: string]; moveVertex: [index: number, point: [number, number]];
  moveVolumeCenter: [point: [number, number]]; moveVolumeHeight: [height: number];
  moveVolumeRadius: [radius: number]; moveBoxSize: [axis: number, size: number];
  rotateBox: [rotation: [number, number, number, number]] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const loading = ref(false);
const loaded = ref(false);
const confirmLargeLoad = ref(false);
const topView = ref(false);
const query = ref(false);
const fps = ref(0);
const boundaryLines = ref<Array<{ key: string; points: string; action: 'keep' | 'remove'; draft: boolean; volume: boolean }>>([]);
const vertexHandles = ref<Array<{ index: number; x: number; y: number }>>([]);
const snapHint = ref<{ x: number; y: number; kind: 'vertex' | 'midpoint' | 'edge' } | null>(null);
const volumeCenterHandle = ref<{ x: number; y: number } | null>(null);
const volumeHeightHandle = ref<{ x: number; y: number } | null>(null);
const volumeRadiusHandle = ref<{ x: number; y: number } | null>(null);
const boxSizeHandles = ref<Array<{ axis: number; x: number; y: number }>>([]);
const boxRotationHandles = ref<Array<{ axis: number; x: number; y: number }>>([]);
const sceneSize = ref({ width: 1, height: 1 });
let draggingVertex: number | null = null;
let draggingVolume = false;
let draggingHeight = false;
let draggingRadius = false;
let draggingBoxAxis: number | null = null;
let draggingRotation: { axis: XYZ; reference: XYZ; center: XYZ; base: [number, number, number, number] } | null = null;
let engine: SingleModelEngine | null = null;
let aborter: AbortController | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let boundaryTimer: ReturnType<typeof setInterval> | null = null;
let lastPointer: [number, number] | null = null;

function snapPolygon(screenPoint: [number, number]): { point: [number, number]; x: number; y: number;
  kind: 'vertex' | 'midpoint' | 'edge' } | null {
  if (!props.snappingPolygon || !engine || !canvas.value) return null;
  const camera = engine.application.camera.camera;
  if (!camera) return null;
  const bounds = engine.scene.bounds(), origin = engine.scene.displayOrigin;
  const z = (bounds.min.z + bounds.max.z) / 2;
  const project = (point: [number, number]) => {
    const screen = camera.worldToScreen(new pc.Vec3(point[0] - origin[0], point[1] - origin[1], z));
    return [screen.x, screen.y] as [number, number];
  };
  const polygons = props.rules.flatMap((rule, index) => rule.type === 'polygon' && index !== props.editingPolygonIndex
    ? [rule.points] : []);
  let best = 12;
  let result: ReturnType<typeof snapPolygon> = null;
  for (const kind of ['vertex', 'midpoint', 'edge'] as const) {
    for (const polygon of polygons) for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index], b = polygon[(index + 1) % polygon.length];
      const sa = project(a), sb = project(b);
      let point: [number, number], screen: [number, number];
      if (kind === 'vertex') { point = a; screen = sa; }
      else if (kind === 'midpoint') {
        point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        screen = [(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2];
      } else {
        const dx = sb[0] - sa[0], dy = sb[1] - sa[1], length = dx * dx + dy * dy;
        if (!length) continue;
        const t = Math.max(0, Math.min(1, ((screenPoint[0] - sa[0]) * dx + (screenPoint[1] - sa[1]) * dy) / length));
        point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        screen = [sa[0] + t * dx, sa[1] + t * dy];
      }
      const distance = Math.hypot(screenPoint[0] - screen[0], screenPoint[1] - screen[1]);
      if (distance < best) { best = distance; result = { point: [...point], x: screen[0], y: screen[1], kind }; }
    }
    if (result) break;
  }
  return result;
}
function updateSnapHint(event: PointerEvent): void {
  if (!canvas.value || !props.snappingPolygon) { snapHint.value = null; return; }
  const rect = canvas.value.getBoundingClientRect();
  lastPointer = [event.clientX - rect.left, event.clientY - rect.top];
  const candidate = snapPolygon(lastPointer);
  snapHint.value = candidate ? { x: candidate.x, y: candidate.y, kind: candidate.kind } : null;
}

function rotateBoxVector(local: XYZ, [w, qx, qy, qz]: [number, number, number, number]): XYZ {
  const cross: XYZ = [qy * local[2] - qz * local[1], qz * local[0] - qx * local[2], qx * local[1] - qy * local[0]];
  const t = cross.map(value => 2 * value) as XYZ;
  return [local[0] + w * t[0] + qy * t[2] - qz * t[1],
    local[1] + w * t[1] + qz * t[0] - qx * t[2],
    local[2] + w * t[2] + qx * t[1] - qy * t[0]];
}

function updateBoundaryLines(): void {
  if (!engine || !canvas.value) return;
  const component = engine.application.camera.camera;
  if (!component) return;
  const bounds = engine.scene.bounds();
  const z = (bounds.min.z + bounds.max.z) / 2;
  const origin = engine.scene.displayOrigin;
  const project3d = (vertices: XYZ[], closed = false) => (closed ? [...vertices, vertices[0]] : vertices).map(([x, y, height]) => {
    const screen = component.worldToScreen(new pc.Vec3(x - origin[0], y - origin[1], height - origin[2]));
    return `${screen.x.toFixed(1)},${screen.y.toFixed(1)}`;
  }).join(' ');
  const project2d = (vertices: [number, number][], closed = false) =>
    project3d(vertices.map(([x, y]) => [x, y, z + origin[2]]), closed);
  const lines: typeof boundaryLines.value = [];
  props.rules.forEach((rule, index) => {
    if (rule.type === 'polygon') {
      lines.push({ key: `rule-${index}`, points: project2d(rule.points, true), action: rule.action, draft: false, volume: false });
    } else if (rule.type === 'sphere') {
      for (let plane = 0; plane < 3; plane++) {
        const points: XYZ[] = Array.from({ length: 32 }, (_, step) => {
          const angle = step * Math.PI / 16;
          const point = [...rule.center] as XYZ;
          point[(plane + 1) % 3] += Math.cos(angle) * rule.radius;
          point[(plane + 2) % 3] += Math.sin(angle) * rule.radius;
          return point;
        });
        lines.push({ key: `rule-${index}-circle-${plane}`, points: project3d(points, true),
          action: rule.action, draft: false, volume: true });
      }
    } else {
      const corners: XYZ[] = Array.from({ length: 8 }, (_, corner) => {
        const local = rule.size.map((size, axis) => size * (corner & (1 << axis) ? 0.5 : -0.5)) as XYZ;
        const rotated = rotateBoxVector(local, rule.rotation);
        return rotated.map((value, axis) => value + rule.center[axis]) as XYZ;
      });
      for (let corner = 0; corner < 8; corner++) for (let axis = 0; axis < 3; axis++) {
        if (corner & (1 << axis)) continue;
        lines.push({ key: `rule-${index}-edge-${corner}-${axis}`,
          points: project3d([corners[corner], corners[corner | (1 << axis)]]),
          action: rule.action, draft: false, volume: true });
      }
    }
  });
  if (props.polygonDraft.length) lines.push({ key: 'draft', points: project2d(props.polygonDraft), action: 'keep', draft: true, volume: false });
  const handles = props.polygonDraft.map(([x, y], index) => {
    const screen = component.worldToScreen(new pc.Vec3(x - origin[0], y - origin[1], z));
    return { index, x: screen.x, y: screen.y };
  });
  const width = canvas.value.clientWidth, height = canvas.value.clientHeight;
  if (width !== sceneSize.value.width || height !== sceneSize.value.height) sceneSize.value = { width, height };
  if (JSON.stringify(lines) !== JSON.stringify(boundaryLines.value)) boundaryLines.value = lines;
  if (JSON.stringify(handles) !== JSON.stringify(vertexHandles.value)) vertexHandles.value = handles;
  const selected = props.editingVolumeIndex === null || props.editingVolumeIndex === undefined
    ? null : props.rules[props.editingVolumeIndex];
  if (selected && selected.type !== 'polygon') {
    const screen = component.worldToScreen(new pc.Vec3(...selected.center.map((value, axis) => value - origin[axis])));
    if (volumeCenterHandle.value?.x !== screen.x || volumeCenterHandle.value?.y !== screen.y)
      volumeCenterHandle.value = { x: screen.x, y: screen.y };
    const heightOffset = selected.type === 'sphere' ? selected.radius * 0.7 : Math.max(...selected.size) * 1.1;
    const heightScreen = component.worldToScreen(new pc.Vec3(selected.center[0] - origin[0],
      selected.center[1] - origin[1], selected.center[2] + heightOffset - origin[2]));
    if (volumeHeightHandle.value?.x !== heightScreen.x || volumeHeightHandle.value?.y !== heightScreen.y)
      volumeHeightHandle.value = { x: heightScreen.x, y: heightScreen.y };
  } else {
    if (volumeCenterHandle.value) volumeCenterHandle.value = null;
    if (volumeHeightHandle.value) volumeHeightHandle.value = null;
  }
  if (selected?.type === 'sphere') {
    const screen = component.worldToScreen(new pc.Vec3(selected.center[0] + selected.radius - origin[0],
      selected.center[1] - origin[1], selected.center[2] - origin[2]));
    if (volumeRadiusHandle.value?.x !== screen.x || volumeRadiusHandle.value?.y !== screen.y)
      volumeRadiusHandle.value = { x: screen.x, y: screen.y };
  } else if (volumeRadiusHandle.value) volumeRadiusHandle.value = null;
  const boxHandles = selected?.type === 'box' ? ([0, 1, 2] as const).map(axis => {
    const local: XYZ = [0, 0, 0];
    local[axis] = selected.size[axis] / 2;
    const rotated = rotateBoxVector(local, selected.rotation);
    const screen = component.worldToScreen(new pc.Vec3(...rotated.map((value, index) =>
      value + selected.center[index] - origin[index])));
    return { axis, x: screen.x, y: screen.y };
  }) : [];
  if (JSON.stringify(boxHandles) !== JSON.stringify(boxSizeHandles.value)) boxSizeHandles.value = boxHandles;
  const rotationHandles = selected?.type === 'box' ? ([0, 1, 2] as const).map(axis => {
    const local: XYZ = [0, 0, 0];
    local[(axis + 1) % 3] = Math.max(...selected.size) * 0.7;
    const rotated = rotateBoxVector(local, selected.rotation);
    const screen = component.worldToScreen(new pc.Vec3(...rotated.map((value, index) =>
      value + selected.center[index] - origin[index])));
    return { axis, x: screen.x, y: screen.y };
  }) : [];
  if (JSON.stringify(rotationHandles) !== JSON.stringify(boxRotationHandles.value)) boxRotationHandles.value = rotationHandles;
}

function moveVertex(event: PointerEvent): void {
  if (draggingVertex === null || !engine || !canvas.value) return;
  const camera = engine.application.camera.camera;
  if (!camera) return;
  const bounds = engine.scene.bounds();
  const z = (bounds.min.z + bounds.max.z) / 2;
  const canvasBounds = canvas.value.getBoundingClientRect();
  const x = event.clientX - canvasBounds.left, y = event.clientY - canvasBounds.top;
  const snapped = snapPolygon([x, y]);
  snapHint.value = snapped ? { x: snapped.x, y: snapped.y, kind: snapped.kind } : null;
  if (snapped) { emit('moveVertex', draggingVertex, snapped.point); return; }
  const near = camera.screenToWorld(x, y, camera.nearClip);
  const far = camera.screenToWorld(x, y, camera.farClip);
  const delta = far.z - near.z;
  if (Math.abs(delta) < 1e-8) return;
  const ratio = (z - near.z) / delta;
  if (ratio < 0 || ratio > 1) return;
  const origin = engine.scene.displayOrigin;
  emit('moveVertex', draggingVertex, [near.x + (far.x - near.x) * ratio + origin[0],
    near.y + (far.y - near.y) * ratio + origin[1]]);
}
function startVertexDrag(index: number, event: PointerEvent): void {
  draggingVertex = index;
  (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
  event.stopPropagation();
}
function endVertexDrag(event: PointerEvent): void {
  draggingVertex = null;
  snapHint.value = null;
  (event.currentTarget as SVGCircleElement).releasePointerCapture(event.pointerId);
}
function pointOnVolumePlane(event: PointerEvent): [number, number] | null {
  if (!engine || !canvas.value || props.editingVolumeIndex === null
    || props.editingVolumeIndex === undefined) return null;
  const rule = props.rules[props.editingVolumeIndex];
  const camera = engine.application.camera.camera;
  if (!rule || rule.type === 'polygon' || !camera) return null;
  const bounds = canvas.value.getBoundingClientRect();
  const near = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.nearClip);
  const far = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.farClip);
  const origin = engine.scene.displayOrigin;
  const z = rule.center[2] - origin[2];
  const delta = far.z - near.z;
  if (Math.abs(delta) < 1e-8) return null;
  const ratio = (z - near.z) / delta;
  if (ratio < 0 || ratio > 1) return null;
  return [near.x + (far.x - near.x) * ratio + origin[0],
    near.y + (far.y - near.y) * ratio + origin[1]];
}
function moveVolume(event: PointerEvent): void {
  if (!draggingVolume) return;
  const point = pointOnVolumePlane(event);
  if (point) emit('moveVolumeCenter', point);
}
function moveVolumeRadius(event: PointerEvent): void {
  if (!draggingRadius || props.editingVolumeIndex === null || props.editingVolumeIndex === undefined) return;
  const rule = props.rules[props.editingVolumeIndex];
  if (rule?.type !== 'sphere') return;
  const point = pointOnVolumePlane(event);
  if (point) emit('moveVolumeRadius', Math.max(0.001, Math.hypot(point[0] - rule.center[0], point[1] - rule.center[1])));
}
function startVolumeDrag(event: PointerEvent): void {
  draggingVolume = true;
  (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
  event.stopPropagation();
}
function endVolumeDrag(event: PointerEvent): void {
  draggingVolume = false;
  (event.currentTarget as SVGCircleElement).releasePointerCapture(event.pointerId);
}
function moveVolumeHeight(event: PointerEvent): void {
  if (!draggingHeight || !engine || !canvas.value || props.editingVolumeIndex == null) return;
  const rule = props.rules[props.editingVolumeIndex];
  const camera = engine.application.camera.camera;
  if (!rule || rule.type === 'polygon' || !camera) return;
  const bounds = canvas.value.getBoundingClientRect();
  const near = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.nearClip);
  const far = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.farClip);
  const direction = far.sub(near).normalize();
  const denominator = 1 - direction.z * direction.z;
  if (denominator < 1e-5) return;
  const origin = engine.scene.displayOrigin;
  const offset = new pc.Vec3(near.x + origin[0] - rule.center[0],
    near.y + origin[1] - rule.center[1], near.z + origin[2] - rule.center[2]);
  const distance = (offset.z - direction.z * direction.dot(offset)) / denominator;
  emit('moveVolumeHeight', rule.center[2] + distance - (rule.type === 'sphere' ? rule.radius * 0.7 : Math.max(...rule.size) * 1.1));
}
function startHeightDrag(event: PointerEvent): void {
  draggingHeight = true;
  (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
  event.stopPropagation();
}
function endHeightDrag(event: PointerEvent): void {
  draggingHeight = false;
  (event.currentTarget as SVGCircleElement).releasePointerCapture(event.pointerId);
}
function startRadiusDrag(event: PointerEvent): void {
  draggingRadius = true;
  (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
  event.stopPropagation();
}
function endRadiusDrag(event: PointerEvent): void {
  draggingRadius = false;
  (event.currentTarget as SVGCircleElement).releasePointerCapture(event.pointerId);
}
function moveBoxSize(event: PointerEvent): void {
  if (draggingBoxAxis === null || !engine || !canvas.value || props.editingVolumeIndex == null) return;
  const rule = props.rules[props.editingVolumeIndex];
  const camera = engine.application.camera.camera;
  if (rule?.type !== 'box' || !camera) return;
  const bounds = canvas.value.getBoundingClientRect();
  const near = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.nearClip);
  const far = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.farClip);
  const direction = far.sub(near).normalize();
  const origin = engine.scene.displayOrigin;
  const offset = new pc.Vec3(near.x + origin[0] - rule.center[0],
    near.y + origin[1] - rule.center[1], near.z + origin[2] - rule.center[2]);
  const local: XYZ = [0, 0, 0]; local[draggingBoxAxis] = 1;
  const axis = new pc.Vec3(...rotateBoxVector(local, rule.rotation)).normalize();
  const alignment = axis.dot(direction);
  const denominator = 1 - alignment * alignment;
  if (denominator < 1e-5) return;
  const distance = (axis.dot(offset) - alignment * direction.dot(offset)) / denominator;
  emit('moveBoxSize', draggingBoxAxis, Math.max(0.001, 2 * distance));
}
function startBoxSizeDrag(axis: number, event: PointerEvent): void {
  draggingBoxAxis = axis;
  (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
  event.stopPropagation();
}
function endBoxSizeDrag(event: PointerEvent): void {
  draggingBoxAxis = null;
  (event.currentTarget as SVGCircleElement).releasePointerCapture(event.pointerId);
}
function startBoxRotation(axisIndex: number, event: PointerEvent): void {
  if (props.editingVolumeIndex == null) return;
  const rule = props.rules[props.editingVolumeIndex];
  if (rule?.type !== 'box') return;
  const length = Math.hypot(...rule.rotation);
  if (length < 1e-8) return;
  const base = rule.rotation.map(value => value / length) as [number, number, number, number];
  const localAxis: XYZ = [0, 0, 0], localReference: XYZ = [0, 0, 0];
  localAxis[axisIndex] = 1;
  localReference[(axisIndex + 1) % 3] = 1;
  draggingRotation = { axis: rotateBoxVector(localAxis, base), reference: rotateBoxVector(localReference, base),
    center: [...rule.center], base };
  (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId);
  event.stopPropagation();
}
function moveBoxRotation(event: PointerEvent): void {
  if (!draggingRotation || !engine || !canvas.value) return;
  const camera = engine.application.camera.camera;
  if (!camera) return;
  const bounds = canvas.value.getBoundingClientRect();
  const near = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.nearClip);
  const far = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.farClip);
  const ray = far.sub(near);
  const axis = new pc.Vec3(...draggingRotation.axis);
  const denominator = ray.dot(axis);
  if (Math.abs(denominator) < 1e-6) return;
  const origin = engine.scene.displayOrigin;
  const center = new pc.Vec3(...draggingRotation.center.map((value, index) => value - origin[index]));
  const ratio = center.clone().sub(near).dot(axis) / denominator;
  if (ratio < 0 || ratio > 1) return;
  const direction = near.add(ray.mulScalar(ratio)).sub(center).normalize();
  const reference = new pc.Vec3(...draggingRotation.reference);
  const cross = new pc.Vec3().cross(reference, direction);
  const angle = Math.atan2(axis.dot(cross), reference.dot(direction));
  const half = angle / 2, sine = Math.sin(half);
  const [w, x, y, z] = draggingRotation.base;
  const [dx, dy, dz] = draggingRotation.axis.map(value => value * sine);
  const dw = Math.cos(half);
  emit('rotateBox', [dw * w - dx * x - dy * y - dz * z,
    dw * x + dx * w + dy * z - dz * y,
    dw * y - dx * z + dy * w + dz * x,
    dw * z + dx * y - dy * x + dz * w]);
}
function endBoxRotation(event: PointerEvent): void {
  draggingRotation = null;
  (event.currentTarget as SVGCircleElement).releasePointerCapture(event.pointerId);
}

async function displayGaussian(confirmed = false): Promise<void> {
  if (!engine || !props.gaussianUrl || loading.value) return;
  if ((props.largeOriginalBytes || props.largeOriginalCount) && !confirmed) { confirmLargeLoad.value = true; return; }
  confirmLargeLoad.value = false;
  loading.value = true;
  try { await engine.showGaussian(props.gaussianUrl, props.filename, props.gaussianLod); loaded.value = true; }
  catch (error) { emit('notify', error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
function displayPoints(): void { engine?.showPoints(); loaded.value = false; confirmLargeLoad.value = false; }
function fit(): void { engine?.fit(); }
function toggleTop(): void {
  topView.value = !topView.value;
  if (topView.value) engine?.northView([0, 0, 1], [0, 1, 0]);
  else engine?.perspectiveView();
}
function toggleQuery(): void {
  query.value = !query.value;
  engine?.setQueryEnabled(query.value);
  engine?.setQueryPicking(query.value);
}
function applyClip(): void {
  if (!engine) return;
  engine.setAxisClip(props.clip.mode === 'axis', props.clip.min, props.clip.max);
  engine.setBoxClip(props.clip.mode === 'box', props.clip.center, props.clip.size);
  for (const plane of ['xoy', 'xoz', 'yoz'] as const) {
    const value = props.clip.planes[plane];
    engine.setOriginPlane(plane, value.visible, value.side);
  }
}
watch(() => props.clip, applyClip, { deep: true });
watch(() => props.snappingPolygon, value => { if (!value) { snapHint.value = null; lastPointer = null; } });

watch([canvas, () => props.previewUrl], async ([element, url]) => {
  aborter?.abort(); engine?.destroy(); engine = null; loaded.value = false;
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  if (boundaryTimer) { clearInterval(boundaryTimer); boundaryTimer = null; }
  if (!element || !url) return;
  const request = new AbortController(); aborter = request;
  try {
    const cloud = await loadPreview(url, request.signal);
    if (request.signal.aborted || canvas.value !== element) return;
    engine = new SingleModelEngine(element, cloud, props.origin,
      props.transform,
      point => {
        if (props.snappingPolygon && engine) {
          const bounds = engine.scene.bounds(), origin = engine.scene.displayOrigin;
          const screen = engine.application.camera.camera?.worldToScreen(new pc.Vec3(
            point[0] - origin[0], point[1] - origin[1], (bounds.min.z + bounds.max.z) / 2));
          const snapped = snapPolygon(lastPointer ?? (screen ? [screen.x, screen.y] : [Infinity, Infinity]));
          if (snapped) point = [snapped.point[0], snapped.point[1], point[2]];
        }
        emit('pick', point);
        if (query.value) queueMicrotask(() => engine?.setQueryPicking(true));
      },
      undefined, undefined, undefined, undefined, undefined, 'fly');
    applyClip();
    statsTimer = setInterval(() => { fps.value = Math.round(engine?.application.app.stats.frame.fps ?? 0); }, 500);
    boundaryTimer = setInterval(updateBoundaryLines, 50);
  } catch (error) {
    if (!request.signal.aborted) emit('notify', error instanceof Error ? error.message : String(error));
  }
}, { immediate: true, flush: 'post' });
watch([() => props.gaussianUrl, () => props.gaussianLod], () => { displayPoints(); });
watch(() => props.transform, value => engine?.applyTransform(value), { deep: true });
onUnmounted(() => { aborter?.abort(); engine?.destroy(); if (statsTimer) clearInterval(statsTimer);
  if (boundaryTimer) clearInterval(boundaryTimer); });
</script>

<template>
  <div class="editor-scene">
    <canvas ref="canvas" tabindex="0" aria-label="高斯编辑三维场景" @pointerdown="updateSnapHint"
      @pointermove="updateSnapHint" @pointerleave="snapHint = null; lastPointer = null"></canvas>
    <svg class="editor-boundary-overlay" :viewBox="`0 0 ${sceneSize.width} ${sceneSize.height}`" aria-hidden="true">
      <polyline v-for="line in boundaryLines" :key="line.key" :points="line.points"
        :class="[line.action, { draft: line.draft, volume: line.volume }]" />
      <g v-if="snapHint" class="editor-snap-hint">
        <rect v-if="snapHint.kind === 'vertex'" :x="snapHint.x - 6" :y="snapHint.y - 6" width="12" height="12" />
        <path v-else-if="snapHint.kind === 'midpoint'" :d="`M ${snapHint.x} ${snapHint.y - 7} L ${snapHint.x - 7} ${snapHint.y + 5} L ${snapHint.x + 7} ${snapHint.y + 5} Z`" />
        <circle v-else :cx="snapHint.x" :cy="snapHint.y" r="6" />
        <text :x="snapHint.x + 11" :y="snapHint.y - 9">{{ { vertex: '端点', midpoint: '中点', edge: '边线' }[snapHint.kind] }}</text>
      </g>
      <circle v-for="handle in vertexHandles" :key="handle.index" :cx="handle.x" :cy="handle.y" r="6"
        @pointerdown="startVertexDrag(handle.index, $event)" @pointermove="moveVertex" @pointerup="endVertexDrag"
        @pointercancel="endVertexDrag" />
      <circle v-if="volumeCenterHandle" class="volume-center" :cx="volumeCenterHandle.x" :cy="volumeCenterHandle.y" r="9"
        @pointerdown="startVolumeDrag" @pointermove="moveVolume" @pointerup="endVolumeDrag" @pointercancel="endVolumeDrag" />
      <circle v-if="volumeHeightHandle" class="volume-height" :cx="volumeHeightHandle.x" :cy="volumeHeightHandle.y" r="8"
        @pointerdown="startHeightDrag" @pointermove="moveVolumeHeight" @pointerup="endHeightDrag" @pointercancel="endHeightDrag">
        <title>调整中心 Z</title>
      </circle>
      <circle v-if="volumeRadiusHandle" class="volume-radius" :cx="volumeRadiusHandle.x" :cy="volumeRadiusHandle.y" r="8"
        @pointerdown="startRadiusDrag" @pointermove="moveVolumeRadius" @pointerup="endRadiusDrag" @pointercancel="endRadiusDrag" />
      <circle v-for="handle in boxSizeHandles" :key="handle.axis" class="box-size" :class="`axis-${handle.axis}`"
        :cx="handle.x" :cy="handle.y" r="8" @pointerdown="startBoxSizeDrag(handle.axis, $event)"
        @pointermove="moveBoxSize" @pointerup="endBoxSizeDrag" @pointercancel="endBoxSizeDrag" />
      <circle v-for="handle in boxRotationHandles" :key="handle.axis" class="box-rotation" :class="`axis-${handle.axis}`"
        :cx="handle.x" :cy="handle.y" r="10" @pointerdown="startBoxRotation(handle.axis, $event)"
        @pointermove="moveBoxRotation" @pointerup="endBoxRotation" @pointercancel="endBoxRotation">
        <title>绕局部{{ ['X', 'Y', 'Z'][handle.axis] }}轴旋转</title>
      </circle>
    </svg>
    <div class="editor-scene-tools">
      <button type="button" @click="fit">适配视角</button>
      <button type="button" :class="{ active: topView }" @click="toggleTop">{{ topView ? '返回三维' : '俯视' }}</button>
      <button type="button" :class="{ active: query }" @click="toggleQuery">场景取点</button>
      <button type="button" :disabled="!gaussianUrl || loading" @click="loaded ? displayPoints() : displayGaussian()">
        {{ loading ? '加载高斯中…' : loaded ? '中心点' : '显示高斯' }}
      </button>
      <slot name="tools" />
    </div>
    <div v-if="confirmLargeLoad" class="editor-load-backdrop">
      <div class="editor-load-dialog" role="alertdialog" aria-modal="true" aria-label="加载大文件确认">
        <p>{{ largeOriginalCount ? `当前层约 ${largeOriginalCount.toLocaleString()} 个高斯` : `原始文件约 ${(largeOriginalBytes! / 1048576).toFixed(1)} MiB` }}，直接加载可能耗尽浏览器内存。建议选择较粗 LOD 或先生成轻量工作层。</p>
        <button type="button" @click="confirmLargeLoad = false">取消加载</button>
        <button type="button" @click="displayGaussian(true)">仍要加载原件</button>
      </div>
    </div>
    <button class="editor-view-handle" type="button" title="俯视／三维视角" @click="toggleTop">
      <span>↑ Z</span><strong>{{ topView ? '2D' : '3D' }}</strong>
    </button>
    <div class="editor-scene-hint" role="status">{{ volumeRadiusHandle ? '青色手柄移动 X／Y · 紫色手柄移动 Z · 黄色手柄调整半径 · 保存后生效' : boxSizeHandles.length ? '青／紫手柄移动中心 · 实心手柄调整尺寸 · 空心手柄旋转 · 保存后生效' : 'WASD 移动 · Shift 加速 · 滚轮拉近／拉远 · 中键平移 · 左键转向' }}</div>
    <div class="editor-scene-stats">{{ lodLabel }} · 高斯 {{ pointCount?.toLocaleString() ?? (loaded ? '已加载（数量未知）' : '待读取') }} · {{ fps }} FPS</div>
  </div>
</template>

<style scoped>
.editor-scene { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #060d17; }
.editor-scene canvas { display: block; width: 100%; height: 100%; outline: none; }
.editor-boundary-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.editor-boundary-overlay polyline { fill: #56dd9a18; stroke: #56dd9a; stroke-width: 2; vector-effect: non-scaling-stroke; }
.editor-boundary-overlay polyline.remove { fill: #ff826a18; stroke: #ff826a; }
.editor-boundary-overlay polyline.draft { fill: none; stroke-dasharray: 6 4; }
.editor-boundary-overlay polyline.volume { fill: none; stroke-width: 1.5; }
.editor-boundary-overlay .editor-snap-hint :is(rect, path, circle) { fill: none; stroke: #f6d265; stroke-width: 2; pointer-events: none; }
.editor-boundary-overlay .editor-snap-hint text { fill: #f6d265; font-size: 13px; paint-order: stroke; stroke: #07121e; stroke-width: 3px; }
.editor-boundary-overlay circle { fill: #f6d265; stroke: #193a39; stroke-width: 2; pointer-events: all; cursor: move; }
.editor-boundary-overlay circle.volume-center { fill: #8fe3ff; stroke: #104a64; stroke-width: 3; }
.editor-boundary-overlay circle.volume-height { fill: #cb93ff; stroke: #422361; stroke-width: 3; }
.editor-boundary-overlay circle.volume-radius { fill: #f6d265; stroke: #55420d; stroke-width: 3; cursor: ew-resize; }
.editor-boundary-overlay circle.box-size { stroke: #07121e; stroke-width: 3; }
.editor-boundary-overlay circle.axis-0 { fill: #f47878; }
.editor-boundary-overlay circle.axis-1 { fill: #71d690; }
.editor-boundary-overlay circle.axis-2 { fill: #6ea9ff; }
.editor-boundary-overlay circle.box-rotation { fill: #07121e; stroke-width: 3; cursor: grab; }
.editor-boundary-overlay circle.box-rotation.axis-0 { stroke: #f47878; }
.editor-boundary-overlay circle.box-rotation.axis-1 { stroke: #71d690; }
.editor-boundary-overlay circle.box-rotation.axis-2 { stroke: #6ea9ff; }
.editor-load-backdrop { position: absolute; inset: 0; z-index: 7; display: grid; place-items: center; background: #030a12a8; }
.editor-load-dialog { box-sizing: border-box; width: min(390px, calc(100% - 32px)); padding: 18px; border: 1px solid #6b879e; border-radius: 9px; background: #102136; box-shadow: 0 16px 40px #0008; }
.editor-load-dialog p { margin: 0 0 16px; line-height: 1.5; }
.editor-load-dialog button { margin-right: 8px; padding: 7px 10px; border: 1px solid #61809a; border-radius: 5px; color: #edf5ff; background: #17334c; cursor: pointer; }
.editor-scene canvas:focus-visible { outline: 2px solid #78d6b8; outline-offset: -2px; }
.editor-scene-tools { position: absolute; z-index: 3; top: 12px; left: 12px; right: 96px; display: flex; flex-wrap: wrap; gap: 6px; pointer-events: none; }
.editor-scene-tools :deep(*) { pointer-events: auto; }
button { padding: 7px 10px; border: 1px solid #43617e; border-radius: 6px; background: #12283de8; color: #e5f5ff; cursor: pointer; }
.editor-scene-tools :deep(button) { padding: 7px 10px; border: 1px solid #43617e; border-radius: 6px; background: #12283de8; color: #e5f5ff; cursor: pointer; }
button.active { border-color: #78d6b8; color: #78d6b8; }
button:disabled { opacity: .55; cursor: default; }
.editor-view-handle { position: absolute; z-index: 4; top: 12px; right: 12px; display: grid; place-items: center; width: 66px; height: 66px; border-radius: 50%; }
.editor-view-handle span { font-size: 16px; }.editor-view-handle strong { font-size: 12px; }
.editor-scene-hint, .editor-scene-stats { position: absolute; z-index: 3; bottom: 12px; padding: 8px 11px; border: 1px solid #385574; border-radius: 6px; background: #0b1929e8; color: #c5d8e8; font-size: 12px; }
.editor-scene-hint { left: 12px; }.editor-scene-stats { right: 12px; }
@media (max-width: 700px) { .editor-scene-hint { bottom: 50px; right: 12px; }.editor-scene-stats { left: 12px; right: auto; } }
</style>
