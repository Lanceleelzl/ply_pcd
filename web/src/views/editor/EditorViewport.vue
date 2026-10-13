<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import type { XYZ } from '../../coordinate-math';
import { loadPreview } from '../../point-cloud';
import { SingleModelEngine } from '../../engine/core/SingleModelEngine';

const props = defineProps<{ previewUrl: string; gaussianUrl?: string | null; filename: string;
  origin: XYZ; pointCount?: number; lodLabel: string }>();
const emit = defineEmits<{ pick: [point: XYZ]; notify: [message: string] }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const loading = ref(false);
const loaded = ref(false);
const topView = ref(false);
const query = ref(false);
const fps = ref(0);
let engine: SingleModelEngine | null = null;
let aborter: AbortController | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;

async function displayGaussian(): Promise<void> {
  if (!engine || !props.gaussianUrl || loading.value) return;
  loading.value = true;
  try { await engine.showGaussian(props.gaussianUrl, props.filename); loaded.value = true; }
  catch (error) { emit('notify', error instanceof Error ? error.message : String(error)); }
  finally { loading.value = false; }
}
function displayPoints(): void { engine?.showPoints(); loaded.value = false; }
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

watch([canvas, () => props.previewUrl], async ([element, url]) => {
  aborter?.abort(); engine?.destroy(); engine = null; loaded.value = false;
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  if (!element || !url) return;
  const request = new AbortController(); aborter = request;
  try {
    const cloud = await loadPreview(url, request.signal);
    if (request.signal.aborted || canvas.value !== element) return;
    engine = new SingleModelEngine(element, cloud, props.origin,
      { translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] },
      point => { emit('pick', point); if (query.value) engine?.setQueryPicking(true); },
      undefined, undefined, undefined, undefined, undefined, 'fly');
    statsTimer = setInterval(() => { fps.value = Math.round(engine?.application.app.stats.frame.fps ?? 0); }, 500);
  } catch (error) {
    if (!request.signal.aborted) emit('notify', error instanceof Error ? error.message : String(error));
  }
}, { immediate: true, flush: 'post' });
watch(() => props.gaussianUrl, () => { displayPoints(); });
onUnmounted(() => { aborter?.abort(); engine?.destroy(); if (statsTimer) clearInterval(statsTimer); });
</script>

<template>
  <div class="editor-scene">
    <canvas ref="canvas" tabindex="0" aria-label="高斯编辑三维场景"></canvas>
    <div class="editor-scene-tools">
      <button type="button" @click="fit">适配视角</button>
      <button type="button" :class="{ active: topView }" @click="toggleTop">{{ topView ? '返回三维' : '俯视' }}</button>
      <button type="button" :class="{ active: query }" @click="toggleQuery">场景取点</button>
      <button type="button" :disabled="!gaussianUrl || loading" @click="loaded ? displayPoints() : displayGaussian()">
        {{ loading ? '加载高斯中…' : loaded ? '中心点' : '显示高斯' }}
      </button>
      <slot name="tools" />
    </div>
    <button class="editor-view-handle" type="button" title="俯视／三维视角" @click="toggleTop">
      <span>↑ Z</span><strong>{{ topView ? '2D' : '3D' }}</strong>
    </button>
    <div class="editor-scene-hint" role="status">WASD 移动 · Shift 加速 · 滚轮拉近／拉远 · 中键平移 · 左键转向</div>
    <div class="editor-scene-stats">{{ lodLabel }} · 高斯 {{ pointCount?.toLocaleString() ?? '待读取' }} · {{ fps }} FPS</div>
  </div>
</template>

<style scoped>
.editor-scene { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #060d17; }
.editor-scene canvas { display: block; width: 100%; height: 100%; outline: none; }
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
