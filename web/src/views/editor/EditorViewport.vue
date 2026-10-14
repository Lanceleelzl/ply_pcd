<script setup lang="ts">
import * as pc from 'playcanvas';
import { onUnmounted, ref, watch } from 'vue';
import type { XYZ } from '../../coordinate-math';
import type { EditorDisplayClip, EditorRule, EditorTransform } from '../../api/gaussian-editor-api';
import { loadPreview } from '../../point-cloud';
import { SingleModelEngine } from '../../engine/core/SingleModelEngine';

const props = defineProps<{ previewUrl: string; gaussianUrl?: string | null; filename: string; gaussianLod?: number;
  origin: XYZ; pointCount?: number; lodLabel: string; transform: EditorTransform; largeOriginalBytes?: number;
  rules: EditorRule[]; polygonDraft: [number, number][]; editingVolumeIndex?: number | null;
  clip: EditorDisplayClip }>();
const emit = defineEmits<{ pick: [point: XYZ]; notify: [message: string]; moveVertex: [index: number, point: [number, number]];
  moveVolumeCenter: [point: [number, number]] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const loading = ref(false);
const loaded = ref(false);
const confirmLargeLoad = ref(false);
const topView = ref(false);
const query = ref(false);
const fps = ref(0);
const boundaryLines = ref<Array<{ key: string; points: string; action: 'keep' | 'remove'; draft: boolean; volume: boolean }>>([]);
const vertexHandles = ref<Array<{ index: number; x: number; y: number }>>([]);
const volumeCenterHandle = ref<{ x: number; y: number } | null>(null);
const sceneSize = ref({ width: 1, height: 1 });
let draggingVertex: number | null = null;
let draggingVolume = false;
let engine: SingleModelEngine | null = null;
let aborter: AbortController | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let boundaryTimer: ReturnType<typeof setInterval> | null = null;

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
      const [w, qx, qy, qz] = rule.rotation;
      const corners: XYZ[] = Array.from({ length: 8 }, (_, corner) => {
        const local = rule.size.map((size, axis) => size * (corner & (1 << axis) ? 0.5 : -0.5)) as XYZ;
        const cross: XYZ = [qy * local[2] - qz * local[1], qz * local[0] - qx * local[2], qx * local[1] - qy * local[0]];
        const t = cross.map(value => 2 * value) as XYZ;
        const rotated: XYZ = [local[0] + w * t[0] + qy * t[2] - qz * t[1],
          local[1] + w * t[1] + qz * t[0] - qx * t[2],
          local[2] + w * t[2] + qx * t[1] - qy * t[0]];
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
  } else if (volumeCenterHandle.value) volumeCenterHandle.value = null;
}

function moveVertex(event: PointerEvent): void {
  if (draggingVertex === null || !engine || !canvas.value) return;
  const camera = engine.application.camera.camera;
  if (!camera) return;
  const bounds = engine.scene.bounds();
  const z = (bounds.min.z + bounds.max.z) / 2;
  const canvasBounds = canvas.value.getBoundingClientRect();
  const x = event.clientX - canvasBounds.left, y = event.clientY - canvasBounds.top;
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
  (event.currentTarget as SVGCircleElement).releasePointerCapture(event.pointerId);
}
function moveVolume(event: PointerEvent): void {
  if (!draggingVolume || !engine || !canvas.value || props.editingVolumeIndex === null
    || props.editingVolumeIndex === undefined) return;
  const rule = props.rules[props.editingVolumeIndex];
  const camera = engine.application.camera.camera;
  if (!rule || rule.type === 'polygon' || !camera) return;
  const bounds = canvas.value.getBoundingClientRect();
  const near = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.nearClip);
  const far = camera.screenToWorld(event.clientX - bounds.left, event.clientY - bounds.top, camera.farClip);
  const origin = engine.scene.displayOrigin;
  const z = rule.center[2] - origin[2];
  const delta = far.z - near.z;
  if (Math.abs(delta) < 1e-8) return;
  const ratio = (z - near.z) / delta;
  if (ratio < 0 || ratio > 1) return;
  emit('moveVolumeCenter', [near.x + (far.x - near.x) * ratio + origin[0],
    near.y + (far.y - near.y) * ratio + origin[1]]);
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

async function displayGaussian(confirmed = false): Promise<void> {
  if (!engine || !props.gaussianUrl || loading.value) return;
  if (props.largeOriginalBytes && !confirmed) { confirmLargeLoad.value = true; return; }
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
      point => { emit('pick', point); if (query.value) queueMicrotask(() => engine?.setQueryPicking(true)); },
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
    <canvas ref="canvas" tabindex="0" aria-label="高斯编辑三维场景"></canvas>
    <svg class="editor-boundary-overlay" :viewBox="`0 0 ${sceneSize.width} ${sceneSize.height}`" aria-hidden="true">
      <polyline v-for="line in boundaryLines" :key="line.key" :points="line.points"
        :class="[line.action, { draft: line.draft, volume: line.volume }]" />
      <circle v-for="handle in vertexHandles" :key="handle.index" :cx="handle.x" :cy="handle.y" r="6"
        @pointerdown="startVertexDrag(handle.index, $event)" @pointermove="moveVertex" @pointerup="endVertexDrag"
        @pointercancel="endVertexDrag" />
      <circle v-if="volumeCenterHandle" class="volume-center" :cx="volumeCenterHandle.x" :cy="volumeCenterHandle.y" r="9"
        @pointerdown="startVolumeDrag" @pointermove="moveVolume" @pointerup="endVolumeDrag" @pointercancel="endVolumeDrag" />
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
        <p>原始文件约 {{ (largeOriginalBytes! / 1048576).toFixed(1) }} MiB，直接加载可能耗尽浏览器内存。建议先生成轻量工作层。</p>
        <button type="button" @click="confirmLargeLoad = false">取消加载</button>
        <button type="button" @click="displayGaussian(true)">仍要加载原件</button>
      </div>
    </div>
    <button class="editor-view-handle" type="button" title="俯视／三维视角" @click="toggleTop">
      <span>↑ Z</span><strong>{{ topView ? '2D' : '3D' }}</strong>
    </button>
    <div class="editor-scene-hint" role="status">WASD 移动 · Shift 加速 · 滚轮拉近／拉远 · 中键平移 · 左键转向</div>
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
.editor-boundary-overlay circle { fill: #f6d265; stroke: #193a39; stroke-width: 2; pointer-events: all; cursor: move; }
.editor-boundary-overlay circle.volume-center { fill: #8fe3ff; stroke: #104a64; stroke-width: 3; }
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
