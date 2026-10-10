<script setup lang="ts">
import * as pc from 'playcanvas';
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { RegistrationApplication } from '../../engine/core/Application';
import { InputController } from '../../engine/core/InputController';
import { TransformGizmoInput } from '../../engine/core/TransformGizmoInput';
import { ViewportCameraController } from '../../engine/core/ViewportCameraController';
import { createPointCloudEntity, type PointCloudMaterial, type PreviewCloud } from '../../point-cloud';
import { SingleGaussianDisplay } from '../../engine/modules/SingleGaussianDisplay';
import { apiFetch, getApiKey } from '../../api/api-auth';
import type { Region } from '../../api/merge-api';

const props = defineProps<{
  samples: number[][][]; regions: Region[]; drawing: [number, number][];
  selected: number; targetModel: number; drawingMode: boolean; editingRegion: number | null;
  displays: ('points' | 'gaussian')[]; gaussianUrls: string[];
  modelTranslations: [number, number, number][]; modelRotations: number[][];
  modelAxes: number[][]; modelScales: number[]; visibleModels: boolean[];
  selectedVertex: number | null;
  operationHint: string;
}>();
const emit = defineEmits<{
  point: [point: [number, number]];
  finish: [];
  vertex: [index: number, point: [number, number]];
  vertexEnd: [];
  move: [model: number, delta: [number, number, number]];
  rotate: [model: number, delta: [number, number, number, number], pivot: [number, number, number]];
  moveEnd: [];
  vertexStart: [];
  vertexSelect: [index: number | null];
  vertexInsert: [index: number, point: [number, number]];
  vertexDelete: [index: number];
}>();
const viewport = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const error = ref('');
let application: RegistrationApplication | null = null;
let camera: ViewportCameraController | null = null;
let input: InputController | null = null;
let gizmo: pc.TranslateGizmo | null = null;
let rotateGizmo: pc.RotateGizmo | null = null;
let gizmoInput: TransformGizmoInput | null = null;
let roots: pc.Entity[] = [];
let centers: pc.Vec3[] = [];
let handle: pc.Entity | null = null;
let materials: PointCloudMaterial[] = [];
let gaussianParents: pc.Entity[] = [];
let gaussianDisplays: SingleGaussianDisplay[] = [];
let loadedGaussianUrls: string[] = [];
let displayGeneration = 0;
let dragging = false;
let drawingPress = false;
let editingVertex: number | null = null;
let last = new pc.Vec3();
let lastRotation = new pc.Quat();
let fitted = false;
const topLocked = ref(true);
const compassDegrees = ref(0);
const originAxisLabels = ref<Array<{ text: string; x: number; y: number; color: string }>>([]);
const selectedVertex = ref<number | null>(null);
const selectedVertexScreen = ref<[number, number]>([0, 0]);
const editHover = ref<{ kind: 'vertex' | 'edge'; index: number; screen: [number, number] } | null>(null);
type SnapCandidate = { kind: 'vertex' | 'midpoint' | 'edge' | 'close'; point: [number, number];
  screen: [number, number]; pointer: [number, number] };
const snapIndicator = ref<SnapCandidate | null>(null);
let sceneBounds = { min: new pc.Vec3(-1, -1, -1), max: new pc.Vec3(1, 1, 1) };
let vertexMarkSize = 0.05;
const onVertexPointerMove = (event: PointerEvent) => {
  if (editingVertex === null) return;
  updateSnapIndicator(event);
  const point = snapPoint(event, props.editingRegion);
  if (point) emit('vertex', editingVertex, point);
};
function updateSnapIndicator(event: PointerEvent) {
  if (!canvas.value || !canvas.value.contains(event.target as Node) ||
      (!props.drawingMode && editingVertex === null)) { snapIndicator.value = null; return; }
  const candidate = props.drawingMode && closeToFirstPoint(event)
    ? { kind: 'close' as const, point: props.drawing[0], screen: screenPoint(props.drawing[0])!, pointer: pointerPoint(event)! }
    : snapCandidate(event, editingVertex === null ? null : props.editingRegion);
  const previous = snapIndicator.value;
  if (!candidate || !previous || previous.kind !== candidate.kind ||
      Math.hypot(previous.screen[0] - candidate.screen[0], previous.screen[1] - candidate.screen[1]) > 0.5 ||
      Math.hypot(previous.pointer[0] - candidate.pointer[0], previous.pointer[1] - candidate.pointer[1]) > 0.5)
    snapIndicator.value = candidate;
}
function clearSnapIndicator() { snapIndicator.value = null; }
function updateEditHover(event: PointerEvent) {
  if (!canvas.value?.contains(event.target as Node) || props.editingRegion === null ||
      props.drawingMode || editingVertex !== null) { editHover.value = null; return; }
  const vertex = hitVertex(event, 18);
  if (vertex !== null) {
    const point = props.regions[props.editingRegion]?.polygon[vertex] as [number, number] | undefined;
    const screen = point && screenPoint(point);
    editHover.value = screen ? { kind: 'vertex', index: vertex, screen } : null;
    return;
  }
  const segment = hitSegment(event);
  const screen = segment && screenPoint(segment.point);
  editHover.value = segment && screen ? { kind: 'edge', index: segment.index, screen } : null;
}
function clearEditHover(event: PointerEvent) {
  if ((event.relatedTarget as HTMLElement | null)?.closest?.('.vertex-delete')) return;
  editHover.value = null;
}
const colors = [new pc.Color(0.4, 0.85, 0.7), new pc.Color(0.96, 0.67, 0.42),
  new pc.Color(0.55, 0.74, 1), new pc.Color(0.84, 0.62, 0.97)];

function computeBounds() {
  const min = new pc.Vec3(Infinity, Infinity, Infinity);
  const max = new pc.Vec3(-Infinity, -Infinity, -Infinity);
  for (const model of props.samples) for (const point of model) {
    min.min(new pc.Vec3(point[0], point[1], point[2]));
    max.max(new pc.Vec3(point[0], point[1], point[2]));
  }
  if (!Number.isFinite(min.x)) return { min: new pc.Vec3(-1, -1, -1), max: new pc.Vec3(1, 1, 1) };
  return { min, max };
}
function bounds() { return sceneBounds; }
function replaceModels() {
  const current = application;
  if (!current) return;
  gizmo?.detach();
  roots.forEach(root => root.destroy()); materials.forEach(material => material.destroy());
  roots = []; centers = []; materials = [];
  sceneBounds = computeBounds();
  vertexMarkSize = Math.max(sceneBounds.max.clone().sub(sceneBounds.min).length() / 120, 0.05);
  props.samples.forEach((points, index) => {
    if (!points.length) return;
    const positions = new Float32Array(points.flat());
    const min = new pc.Vec3(Infinity, Infinity, Infinity);
    const max = new pc.Vec3(-Infinity, -Infinity, -Infinity);
    for (const point of points) { min.min(new pc.Vec3(...point)); max.max(new pc.Vec3(...point)); }
    const cloud: PreviewCloud = { positions, count: points.length, min, max };
    centers[index] = min.clone().add(max).mulScalar(0.5);
    const root = new pc.Entity(`Merge model ${index + 1}`);
    const child = createPointCloudEntity(current.app, cloud, colors[index % colors.length], `Merge ${index}`);
    root.addChild(child);
    current.app.root.addChild(root);
    root.enabled = props.displays[index] === 'points' && props.visibleModels[index] !== false;
    roots[index] = root;
    materials.push(child.render!.meshInstances[0].material as PointCloudMaterial);
  });
  selectModel();
  if (!fitted && props.samples.some(points => points.length)) { camera?.fit(); top(); fitted = true; }
}
function updateGaussianTransforms() {
  gaussianParents.forEach((parent, index) => {
    parent.enabled = props.visibleModels[index] !== false;
    parent.setPosition(...(props.modelTranslations[index] ?? [0, 0, 0]));
    const [w, x, y, z] = props.modelRotations[index] ?? [1, 0, 0, 0];
    parent.setRotation(new pc.Quat(x, y, z, w).mul(
      new pc.Quat().setFromEulerAngles(props.modelAxes[index]?.[1] === -3 ? 90 : 0, 0, 0)));
    const factor = props.modelScales[index] ?? 1;
    parent.setLocalScale(factor, factor, factor);
  });
}
async function updateDisplay() {
  const generation = ++displayGeneration;
  if (!application) return;
  for (let index = 0; index < props.gaussianUrls.length; index++) {
    if (generation !== displayGeneration) return;
    if (props.displays[index] !== 'gaussian' || props.visibleModels[index] === false) {
      gaussianDisplays[index]?.showPoints();
      loadedGaussianUrls[index] = '';
      if (roots[index]) roots[index].enabled = props.displays[index] === 'points' && props.visibleModels[index] !== false;
      continue;
    }
    let url = props.gaussianUrls[index];
    if (loadedGaussianUrls[index] === url) continue;
    loadedGaussianUrls[index] = url;
    let blobUrl = '';
    try {
      if (getApiKey()) {
        const response = await apiFetch(url);
        if (!response.ok) throw new Error(`Gaussian LOD 请求失败：HTTP ${response.status}`);
        blobUrl = URL.createObjectURL(await response.blob());
        url = blobUrl;
      }
      await gaussianDisplays[index]?.show(url, `model-${index}.ply`);
    } catch (reason) { loadedGaussianUrls[index] = ''; error.value = String(reason); }
    finally { if (blobUrl) URL.revokeObjectURL(blobUrl); }
  }
}
function selectModel() {
  gizmo?.detach();
  rotateGizmo?.detach();
  if (props.selected < 0) originAxisLabels.value = [];
  const root = roots[props.selected];
  if (root && props.visibleModels[props.selected] !== false && props.selected !== props.targetModel &&
      !props.drawingMode && props.editingRegion === null) {
    handle?.setPosition(centers[props.selected]);
    const [w, x, y, z] = props.modelRotations[props.selected] ?? [1, 0, 0, 0];
    handle?.setRotation(new pc.Quat(x, y, z, w));
    last.copy(centers[props.selected]);
    if (handle) {
      lastRotation.copy(handle.getRotation());
      gizmo?.attach(handle);
      rotateGizmo?.attach(handle);
    }
  }
}
function top() {
  topLocked.value = true;
  camera?.setProjection(true);
  camera?.setViewDirection(new pc.Vec3(0, 0, 1), new pc.Vec3(0, 1, 0));
}
function fit() { camera?.fit(); top(); }
function perspective() {
  topLocked.value = false;
  camera?.setProjection(false);
  camera?.setViewDirection(new pc.Vec3(1, -1, 1), new pc.Vec3(0, 0, 1));
}
defineExpose({ top });
function drawRegions() {
  if (!application) return;
  drawSelectedOrigin();
  const draw = (points: number[][], color: pc.Color, closed: boolean) => {
    for (let index = 1; index < points.length; index++)
      application!.app.drawLine(new pc.Vec3(points[index - 1][0], points[index - 1][1], 0),
        new pc.Vec3(points[index][0], points[index][1], 0), color, false);
    if (closed && points.length > 2)
      application!.app.drawLine(new pc.Vec3(points.at(-1)![0], points.at(-1)![1], 0),
        new pc.Vec3(points[0][0], points[0][1], 0), color, false);
  };
  props.regions.forEach((region, index) => {
    draw(region.polygon, index === props.editingRegion ? pc.Color.YELLOW :
      new pc.Color(0.4, 0.85, 0.7), true);
    if (index === props.editingRegion) for (const point of region.polygon) {
      application!.app.drawLine(new pc.Vec3(point[0] - vertexMarkSize, point[1], 0),
        new pc.Vec3(point[0] + vertexMarkSize, point[1], 0), pc.Color.YELLOW, false);
      application!.app.drawLine(new pc.Vec3(point[0], point[1] - vertexMarkSize, 0),
        new pc.Vec3(point[0], point[1] + vertexMarkSize, 0), pc.Color.YELLOW, false);
    }
  });
  draw(props.drawing, pc.Color.WHITE, false);
  for (const point of props.drawing) {
    application.app.drawLine(new pc.Vec3(point[0] - vertexMarkSize, point[1], 0),
      new pc.Vec3(point[0] + vertexMarkSize, point[1], 0), pc.Color.WHITE, false);
    application.app.drawLine(new pc.Vec3(point[0], point[1] - vertexMarkSize, 0),
      new pc.Vec3(point[0], point[1] + vertexMarkSize, 0), pc.Color.WHITE, false);
  }
  if (selectedVertex.value !== null && props.editingRegion !== null) {
    const point = props.regions[props.editingRegion]?.polygon[selectedVertex.value];
    if (point) {
      const screen = screenPoint(point as [number, number]);
      if (screen && (Math.abs(screen[0] - selectedVertexScreen.value[0]) > 1 ||
          Math.abs(screen[1] - selectedVertexScreen.value[1]) > 1)) selectedVertexScreen.value = screen;
    }
  }
}
function drawSelectedOrigin() {
  const index = props.selected;
  if (!application || !canvas.value || index < 0 || !props.samples[index]?.length) return;
  const origin = new pc.Vec3(...(props.modelTranslations[index] ?? [0, 0, 0]));
  const length = Math.max(sceneBounds.max.clone().sub(sceneBounds.min).length() * 0.12, 0.5);
  const [w, x, y, z] = props.modelRotations[index] ?? [1, 0, 0, 0];
  const rotation = new pc.Quat(x, y, z, w);
  const labels: Array<{ text: string; x: number; y: number; color: string }> = [];
  const label = (point: pc.Vec3, text: string, color: string) => {
    const cameraComponent = application!.camera.camera!;
    const screen = cameraComponent.worldToScreen(point);
    if (point.clone().sub(application!.camera.getPosition()).dot(application!.camera.forward) <= 0) return;
    const rect = canvas.value!.getBoundingClientRect();
    const sx = screen.x * rect.width / canvas.value!.width;
    const sy = screen.y * rect.height / canvas.value!.height;
    if (sx >= 0 && sx <= rect.width && sy >= 0 && sy <= rect.height)
      labels.push({ text, x: sx, y: sy, color });
  };
  label(origin, 'O', '#edf5ff');
  for (const [axis, color, css] of [
    ['X', pc.Color.RED, '#ff7777'], ['Y', pc.Color.GREEN, '#78e6a2'], ['Z', pc.Color.BLUE, '#85a6ff'],
  ] as const) {
    const fileAxis = 'XYZ'.indexOf(axis) + 1;
    const projected = props.modelAxes[index]?.findIndex(value => Math.abs(value) === fileAxis) ?? fileAxis - 1;
    const direction = new pc.Vec3();
    direction.set(projected === 0 ? 1 : 0, projected === 1 ? 1 : 0, projected === 2 ? 1 : 0);
    direction.mulScalar(Math.sign(props.modelAxes[index]?.[projected] ?? 1) * length);
    const end = origin.clone().add(rotation.transformVector(direction));
    application.app.drawLine(origin, end, color, false);
    label(end, `＋${axis}`, css);
  }
  if (labels.length !== originAxisLabels.value.length || labels.some((item, i) =>
    item.text !== originAxisLabels.value[i]?.text || Math.abs(item.x - originAxisLabels.value[i].x) > 1 ||
    Math.abs(item.y - originAxisLabels.value[i].y) > 1)) originAxisLabels.value = labels;
}
function planePoint(event: PointerEvent): [number, number] | null {
  if (!canvas.value || !application) return null;
  const rect = canvas.value.getBoundingClientRect();
  const x = (event.clientX - rect.left) * canvas.value.width / rect.width;
  const y = (event.clientY - rect.top) * canvas.value.height / rect.height;
  const component = application.camera.camera!;
  const near = component.screenToWorld(x, y, component.nearClip);
  const far = component.screenToWorld(x, y, component.farClip);
  const ratio = -near.z / (far.z - near.z);
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
    ? [near.x + (far.x - near.x) * ratio, near.y + (far.y - near.y) * ratio] : null;
}
function screenPoint(point: [number, number]): [number, number] | null {
  if (!application || !canvas.value) return null;
  const rect = canvas.value.getBoundingClientRect();
  const screen = application.camera.camera!.worldToScreen(new pc.Vec3(point[0], point[1], 0));
  return [screen.x * rect.width / canvas.value.width, screen.y * rect.height / canvas.value.height];
}
function pointerPoint(event: PointerEvent): [number, number] | null {
  if (!canvas.value) return null;
  const rect = canvas.value.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}
function snapCandidate(event: PointerEvent, excludeRegion: number | null): SnapCandidate | null {
  const pointer = pointerPoint(event);
  if (!pointer) return null;
  let best = 12;
  let snapped: SnapCandidate | null = null;
  for (let regionIndex = 0; regionIndex < props.regions.length; regionIndex++) {
    if (regionIndex === excludeRegion) continue;
    for (const point of props.regions[regionIndex].polygon) {
      const screen = screenPoint(point as [number, number]);
      if (!screen) continue;
      const distance = Math.hypot(pointer[0] - screen[0], pointer[1] - screen[1]);
      if (distance < best) { best = distance; snapped = { kind: 'vertex',
        point: [...point] as [number, number], screen, pointer }; }
    }
  }
  if (snapped) return snapped;
  for (let regionIndex = 0; regionIndex < props.regions.length; regionIndex++) {
    if (regionIndex === excludeRegion) continue;
    const polygon = props.regions[regionIndex].polygon;
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index] as [number, number], b = polygon[(index + 1) % polygon.length] as [number, number];
      const point: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const screen = screenPoint(point);
      if (!screen) continue;
      const distance = Math.hypot(pointer[0] - screen[0], pointer[1] - screen[1]);
      if (distance < best) { best = distance; snapped = { kind: 'midpoint', point, screen, pointer }; }
    }
  }
  if (snapped) return snapped;
  for (let regionIndex = 0; regionIndex < props.regions.length; regionIndex++) {
    if (regionIndex === excludeRegion) continue;
    const polygon = props.regions[regionIndex].polygon;
    for (let index = 0; index < polygon.length; index++) {
      const a = polygon[index] as [number, number], b = polygon[(index + 1) % polygon.length] as [number, number];
      const sa = screenPoint(a), sb = screenPoint(b);
      if (!sa || !sb) continue;
      const dx = sb[0] - sa[0], dy = sb[1] - sa[1], lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) continue;
      const t = Math.max(0, Math.min(1, ((pointer[0] - sa[0]) * dx + (pointer[1] - sa[1]) * dy) / lengthSquared));
      const distance = Math.hypot(pointer[0] - sa[0] - t * dx, pointer[1] - sa[1] - t * dy);
      if (distance < best) { best = distance; snapped = { kind: 'edge',
        point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
        screen: [sa[0] + t * dx, sa[1] + t * dy], pointer }; }
    }
  }
  return snapped;
}
function snapPoint(event: PointerEvent, excludeRegion: number | null): [number, number] | null {
  return snapCandidate(event, excludeRegion)?.point ?? planePoint(event);
}
function hitSegment(event: PointerEvent): { index: number; point: [number, number] } | null {
  if (props.editingRegion === null) return null;
  const polygon = props.regions[props.editingRegion]?.polygon;
  const pointer = pointerPoint(event);
  if (!polygon || !pointer) return null;
  let best = 8;
  let hit: { index: number; point: [number, number] } | null = null;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index] as [number, number], b = polygon[(index + 1) % polygon.length] as [number, number];
    const sa = screenPoint(a), sb = screenPoint(b);
    if (!sa || !sb) continue;
    const dx = sb[0] - sa[0], dy = sb[1] - sa[1], lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) continue;
    const t = Math.max(0, Math.min(1, ((pointer[0] - sa[0]) * dx + (pointer[1] - sa[1]) * dy) / lengthSquared));
    const distance = Math.hypot(pointer[0] - sa[0] - t * dx, pointer[1] - sa[1] - t * dy);
    if (distance < best) { best = distance; hit = { index: index + 1,
      point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] }; }
  }
  return hit;
}
function deleteSelectedVertex() {
  const index = editHover.value?.kind === 'vertex' ? editHover.value.index : selectedVertex.value;
  if (index === null) return;
  emit('vertexDelete', index);
  editHover.value = null;
  selectedVertex.value = null;
  emit('vertexSelect', null);
}
function hitVertex(event: PointerEvent, radius = 12): number | null {
  if (!application || !canvas.value || props.editingRegion === null) return null;
  const region = props.regions[props.editingRegion];
  if (!region) return null;
  const rect = canvas.value.getBoundingClientRect();
  const scaleX = rect.width / canvas.value.width;
  const scaleY = rect.height / canvas.value.height;
  for (let index = 0; index < region.polygon.length; index++) {
    const point = region.polygon[index];
    const screen = application.camera.camera!.worldToScreen(new pc.Vec3(point[0], point[1], 0));
    if (Math.hypot(event.clientX - rect.left - screen.x * scaleX,
      event.clientY - rect.top - screen.y * scaleY) <= radius) return index;
  }
  return null;
}
function closeToFirstPoint(event: PointerEvent): boolean {
  if (!application || !canvas.value || props.drawing.length < 3) return false;
  const first = props.drawing[0];
  const screen = application.camera.camera!.worldToScreen(new pc.Vec3(first[0], first[1], 0));
  const rect = canvas.value.getBoundingClientRect();
  return Math.hypot(event.clientX - rect.left - screen.x * rect.width / canvas.value.width,
    event.clientY - rect.top - screen.y * rect.height / canvas.value.height) <= 12;
}
onMounted(() => {
  if (!canvas.value || !viewport.value) return;
  try {
    application = new RegistrationApplication({ canvas: canvas.value, viewport: viewport.value });
    props.gaussianUrls.forEach((_, index) => {
      const parent = new pc.Entity(`Merge Gaussian ${index + 1}`);
      application!.app.root.addChild(parent);
      gaussianParents.push(parent);
      gaussianDisplays.push(new SingleGaussianDisplay(application!.app, parent, [0, 0, 0],
        visible => { if (roots[index]) roots[index].enabled = visible && props.displays[index] === 'points' && props.visibleModels[index] !== false; }));
    });
    updateGaussianTransforms();
    sceneBounds = computeBounds();
    const diagonal = Math.max(sceneBounds.max.clone().sub(sceneBounds.min).length(), 1);
    camera = new ViewportCameraController({ camera: application.camera, canvas: canvas.value,
      orientationChanged: orientation => {
        const north = new pc.Vec3(0, 1, 0);
        compassDegrees.value = Math.atan2(north.dot(new pc.Vec3(orientation.right.x, orientation.right.y, orientation.right.z)),
          north.dot(new pc.Vec3(orientation.cubeUp.x, orientation.cubeUp.y, orientation.cubeUp.z))) * 180 / Math.PI;
      }, baseDiagonal: diagonal, getBounds: bounds });
    gizmo = new pc.TranslateGizmo(application.camera.camera!, pc.TranslateGizmo.createLayer(application.app, 'Merge model translation'));
    rotateGizmo = new pc.RotateGizmo(application.camera.camera!, pc.RotateGizmo.createLayer(application.app, 'Merge model rotation'));
    handle = new pc.Entity('Merge model handle');
    application.app.root.addChild(handle);
    gizmo.axisGap = 0.08; gizmo.axisLineLength = 0.72; gizmo.axisPlaneSize = 0.14; gizmo.axisPlaneGap = 0.22;
    gizmo.flipPlanes = true;
    rotateGizmo.centerRadius = 0.001; rotateGizmo.ringTolerance = 0.025;
    gizmoInput = new TransformGizmoInput(gizmo, rotateGizmo, active => { dragging = active; });
    gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => {
      const position = handle?.getPosition();
      if (!position) return;
      const delta: [number, number, number] = [position.x - last.x, position.y - last.y, position.z - last.z];
      roots[props.selected]?.translate(...delta);
      emit('move', props.selected, delta);
      last.copy(position);
    });
    gizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => { dragging = false; emit('moveEnd'); });
    rotateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMMOVE, () => {
      if (!handle) return;
      const rotation = handle.getRotation().clone();
      const delta = rotation.clone().mul(lastRotation.clone().invert());
      const pivot = handle.getPosition().clone();
      const root = roots[props.selected];
      if (root) {
        root.setRotation(delta.clone().mul(root.getRotation()));
        root.setPosition(pivot.clone().add(delta.transformVector(root.getPosition().clone().sub(pivot))));
      }
      emit('rotate', props.selected, [delta.w, delta.x, delta.y, delta.z], [pivot.x, pivot.y, pivot.z]);
      lastRotation.copy(rotation);
    });
    rotateGizmo.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => { dragging = false; emit('moveEnd'); });
    input = new InputController(canvas.value, camera, {
      orbitEnabled: () => !topLocked.value,
      pointerDown: event => {
        if (event.button === 0 && props.editingRegion !== null) {
          editHover.value = null;
          editingVertex = hitVertex(event);
          if (editingVertex !== null) {
            selectedVertex.value = editingVertex;
            emit('vertexSelect', editingVertex);
            emit('vertexStart');
            return true;
          }
          const segment = hitSegment(event);
          if (segment) {
            emit('vertexInsert', segment.index, segment.point);
            selectedVertex.value = segment.index;
            emit('vertexSelect', segment.index);
            return true;
          }
          selectedVertex.value = null;
          emit('vertexSelect', null);
        }
        drawingPress = props.drawingMode && event.button === 0;
        return drawingPress;
      },
      pointerUp: event => {
        if (editingVertex !== null) { editingVertex = null; clearSnapIndicator(); emit('vertexEnd'); }
        else if (drawingPress && event.button === 0) {
          if (closeToFirstPoint(event)) emit('finish');
          else {
            const point = snapPoint(event, null);
            if (point) emit('point', point);
          }
        }
        drawingPress = false;
      },
      navigationBlocked: event => event.button === 2 || dragging || (event.button === 0 && Boolean(gizmoInput?.hovered)),
      dragBlocked: () => dragging,
    });
    window.addEventListener('pointermove', onVertexPointerMove);
    canvas.value.addEventListener('pointermove', updateSnapIndicator);
    canvas.value.addEventListener('pointerleave', clearSnapIndicator);
    canvas.value.addEventListener('pointermove', updateEditHover);
    canvas.value.addEventListener('pointerleave', clearEditHover);
    application.app.on('update', drawRegions);
    replaceModels(); top(); void updateDisplay();
  } catch (reason) { error.value = String(reason); }
});
watch(() => props.samples, replaceModels);
watch([() => props.displays, () => props.gaussianUrls], () => { void updateDisplay(); }, { deep: true });
watch([() => props.modelTranslations, () => props.modelRotations, () => props.modelAxes, () => props.modelScales], updateGaussianTransforms, { deep: true });
watch(() => props.visibleModels, () => {
  updateGaussianTransforms();
  roots.forEach((root, index) => { if (root) root.enabled = props.displays[index] === 'points' && props.visibleModels[index] !== false; });
  void updateDisplay();
  selectModel();
}, { deep: true });
watch(() => props.selectedVertex, value => { selectedVertex.value = value; });
watch([() => props.selected, () => props.targetModel, () => props.drawingMode, () => props.editingRegion], selectModel);
watch(() => props.editingRegion, () => { selectedVertex.value = null; emit('vertexSelect', null); });
watch([() => props.drawingMode, () => props.editingRegion], () => { editHover.value = null; });
watch([() => props.drawingMode, () => props.editingRegion], () => { snapIndicator.value = null; });
onUnmounted(() => {
  displayGeneration++;
  window.removeEventListener('pointermove', onVertexPointerMove);
  canvas.value?.removeEventListener('pointermove', updateSnapIndicator);
  canvas.value?.removeEventListener('pointerleave', clearSnapIndicator);
  canvas.value?.removeEventListener('pointermove', updateEditHover);
  canvas.value?.removeEventListener('pointerleave', clearEditHover);
  application?.app.off('update', drawRegions);
  input?.destroy(); gizmoInput?.destroy(); gizmo?.destroy(); rotateGizmo?.destroy();
  handle?.destroy();
  roots.forEach(root => root.destroy()); materials.forEach(material => material.destroy());
  gaussianDisplays.forEach(display => display.destroy()); gaussianParents.forEach(parent => parent.destroy());
  application?.destroy();
});
</script>

<template>
  <div ref="viewport" class="merge-viewport" :class="{ 'has-operation-hint': !!operationHint }">
    <canvas ref="canvas" aria-label="高斯合并三维预览" :class="{ 'drawing-cursor': drawingMode }"></canvas>
    <span v-for="label in originAxisLabels" :key="label.text" class="merge-origin-axis-label"
      :style="{ left: `${label.x}px`, top: `${label.y}px`, color: label.color }">{{ label.text }}</span>
    <template v-if="snapIndicator">
      <svg class="snap-guide" aria-hidden="true"><line :x1="snapIndicator.pointer[0]" :y1="snapIndicator.pointer[1]"
        :x2="snapIndicator.screen[0]" :y2="snapIndicator.screen[1]" /></svg>
      <div class="snap-marker" :class="snapIndicator.kind" :style="{ left: `${snapIndicator.screen[0]}px`, top: `${snapIndicator.screen[1]}px` }"
        role="status" :aria-label="snapIndicator.kind === 'vertex' ? '捕捉端点' : snapIndicator.kind === 'midpoint' ? '捕捉中点' : snapIndicator.kind === 'close' ? '闭合边界' : '捕捉边线最近点'">
        <svg v-if="snapIndicator.kind === 'edge'" class="snap-nearest" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M1 1H23L12 12Z M1 23H23L12 12Z" />
        </svg>
        <svg v-else-if="snapIndicator.kind === 'midpoint'" class="snap-midpoint" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2L22 17H2Z" />
        </svg>
        <span v-else class="snap-symbol"></span><span class="snap-label">{{ snapIndicator.kind === 'vertex' ? '端点' : snapIndicator.kind === 'midpoint' ? '中点' : snapIndicator.kind === 'close' ? '闭合' : '边线最近点' }}</span>
      </div>
    </template>
    <div class="merge-viewport-toolbar">
      <button type="button" :class="{ active: topLocked }" @click="fit">俯视正交</button>
      <button type="button" :class="{ active: !topLocked }" @click="perspective">三维透视</button>
      <slot name="tools" />
    </div>
    <div class="merge-viewport-preview-toolbar"><slot name="preview-tools" /></div>
    <button class="merge-compass" type="button" aria-label="指北针：点击切换为俯视正北朝上"
      title="俯视正北朝上" @click="top">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <g :transform="`rotate(${compassDegrees} 32 32)`">
          <text x="32" y="14" class="compass-north">N</text>
          <path v-if="topLocked" class="compass-flat-arrow" d="M32 19L40 43L32 38L24 43Z" />
          <path v-else class="compass-arrow" d="M32 19L46 43L32 37L18 43Z" />
        </g>
        <rect x="18" y="46" width="28" height="13" rx="6" class="compass-mode-bg" />
        <text x="32" y="56" class="compass-mode">{{ topLocked ? '2D' : '3D' }}</text>
      </svg>
    </button>
    <div v-if="editHover?.kind === 'edge'" class="edit-edge-hint"
      :style="{ left: `${editHover.screen[0]}px`, top: `${editHover.screen[1]}px` }" role="status">
      <span>＋</span><small>点击添加点</small>
    </div>
    <div v-if="editHover?.kind === 'vertex'" class="edit-vertex-hint"
      :style="{ left: `${editHover.screen[0]}px`, top: `${editHover.screen[1]}px` }" role="status">
      {{ regions[editingRegion!]?.polygon.length > 3 ? '拖动调整 · 点击 − 删除点' : '拖动调整 · 至少保留 3 点' }}
    </div>
    <button v-if="editingRegion !== null && regions[editingRegion]?.polygon.length > 3 &&
        (selectedVertex !== null || editHover?.kind === 'vertex')"
      type="button" class="vertex-delete" aria-label="删除选中顶点"
      :style="{ left: `${(editHover?.kind === 'vertex' ? editHover.screen[0] : selectedVertexScreen[0]) + 14}px`,
        top: `${(editHover?.kind === 'vertex' ? editHover.screen[1] : selectedVertexScreen[1]) - 14}px` }"
      @click="deleteSelectedVertex" @pointerleave="editHover = null">−</button>
    <slot name="panel" />
    <div v-if="operationHint" class="merge-operation-hint" role="status">{{ operationHint }}</div>
    <p v-if="error" class="merge-viewport-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.merge-viewport { position: relative; min-height: 0; overflow: hidden; background: #08111d; }
.merge-viewport canvas { display: block; width: 100%; height: 100%; }
.merge-viewport canvas.drawing-cursor { cursor: crosshair; }
.merge-origin-axis-label { position: absolute; z-index: 2; pointer-events: none; font-size: 12px; font-weight: 700; text-shadow: 0 1px 3px #08111d; transform: translate(4px, -50%); }
.snap-guide { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 3; pointer-events: none; }
.snap-guide line { stroke: #ffe16a; stroke-width: 1.5; stroke-dasharray: 3 3; }
.snap-marker { position: absolute; z-index: 4; pointer-events: none; color: #ffe16a; }
.snap-symbol { position: absolute; box-sizing: border-box; width: 14px; height: 14px; left: -7px; top: -7px; border: 1px solid currentColor; }
.snap-nearest, .snap-midpoint { position: absolute; left: -12px; top: -12px; width: 24px; height: 24px; overflow: visible; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
.snap-marker.close .snap-symbol { border-radius: 50%; }
.snap-label { position: absolute; left: 13px; top: -13px; white-space: nowrap; padding: 2px 5px; border: 1px solid #c7a932; border-radius: 3px; background: #101b2ded; font-size: 12px; line-height: 1.2; }
.snap-marker.edge .snap-label, .snap-marker.midpoint .snap-label { left: 18px; }
.edit-edge-hint, .edit-vertex-hint { position: absolute; z-index: 4; pointer-events: none; color: #ffe16a; }
.edit-edge-hint span { position: absolute; left: -8px; top: -8px; width: 16px; height: 16px; display: grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; background: #08111d; box-shadow: 0 0 0 4px #ffe16a35; line-height: 1; }
.edit-edge-hint small, .edit-vertex-hint { white-space: nowrap; padding: 3px 6px; border: 1px solid #c7a932; border-radius: 3px; background: #101b2ded; font-size: 12px; }
.edit-edge-hint small { position: absolute; left: 14px; top: -13px; }
.edit-vertex-hint { transform: translate(18px, 14px); }
.merge-viewport-toolbar, .merge-viewport-preview-toolbar { position: absolute; z-index: 4; left: 12px; display: flex; flex-wrap: nowrap; align-items: center; gap: 8px; max-width: calc(100% - 24px); overflow-x: auto; }
.merge-viewport-toolbar { top: 12px; }
.merge-viewport-preview-toolbar { top: 58px; flex-direction: column; align-items: flex-start; gap: 8px; }
.merge-viewport-toolbar > *, .merge-viewport-preview-toolbar > * { flex: none; }
.merge-viewport-toolbar button, .merge-viewport-toolbar :deep(button), .merge-viewport-toolbar :deep(select), .merge-viewport-preview-toolbar :deep(button), .merge-viewport-preview-toolbar :deep(select) { margin: 0; min-height: 38px; padding: 8px; color: #edf5ff; background: #17283d; border: 1px solid #385574; border-radius: 6px; cursor: pointer; font: inherit; font-size: 14px; }
@media (hover: hover) { .merge-viewport-toolbar > button:not(:disabled):hover, .vertex-delete:hover { border-color: #65d9b4; background-color: #1b3a4b; box-shadow: 0 0 0 1px #65d9b43d, 0 3px 10px #0004; transform: translateY(-1px); } }
.merge-viewport-toolbar :deep(button:disabled), .merge-viewport-toolbar :deep(select:disabled), .merge-viewport-preview-toolbar :deep(button:disabled), .merge-viewport-preview-toolbar :deep(select:disabled) { opacity: .5; cursor: default; }
.merge-viewport-toolbar button.active { border-color: #65d9b4; color: #65d9b4; }
.merge-compass { position: absolute; z-index: 5; top: 12px; right: 12px; width: 64px; height: 64px; padding: 3px; border: 1px solid #5acfff; border-radius: 50%; background: radial-gradient(circle at 35% 25%, #2878bc, #12345d 62%, #0a1d35); box-shadow: inset 0 0 0 2px #8ae7ff25, 0 0 12px #41bfff55; color: #edfbff; cursor: pointer; }
.merge-compass:hover { border-color: #b5f4ff; box-shadow: inset 0 0 0 2px #8ae7ff40, 0 0 18px #41bfff88; }
.merge-compass:focus-visible { outline: 2px solid #b5f4ff; outline-offset: 3px; }
.merge-compass svg { display: block; width: 100%; height: 100%; }
.compass-north, .compass-mode { fill: currentColor; font-family: Arial, sans-serif; font-weight: 700; text-anchor: middle; }
.compass-north { font-size: 14px; }
.compass-mode { font-size: 12px; }
.compass-mode-bg { fill: #09213c; stroke: #71d8ff; stroke-width: .8; }
.compass-flat-arrow { fill: #b4f3ff; }
.compass-arrow { fill: #1aa6e033; stroke: currentColor; stroke-width: 3.5; stroke-linejoin: round; }
.merge-operation-hint { position: absolute; z-index: 5; right: 0; bottom: 0; left: 0; padding: 9px 14px; border-top: 1px solid #385574; background: #102036ee; color: #d9e9f8; font-size: 13px; line-height: 1.4; pointer-events: none; }
.vertex-delete { position: absolute; z-index: 5; width: 25px; height: 25px; padding: 0; border: 1px solid #ff9b91; border-radius: 50%; background: #502a30; color: white; cursor: pointer; }
.merge-viewport-error { position: absolute; left: 12px; bottom: 12px; color: #ff9b91; }
.has-operation-hint .merge-viewport-error { bottom: 52px; }
</style>
