<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import type { TransformParameters, XYZ } from '../../coordinate-math';
import { loadPreview } from '../../point-cloud';
import { SingleModelEngine } from '../../engine/core/SingleModelEngine';

const props = defineProps<{ url: string; origin: XYZ; transform: TransformParameters;
  originalUrl?: string; originalFilename?: string; cacheUrl?: string;
  lods?: Array<{ name: string; gaussian_url: string }> }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const error = ref('');
const ready = ref(false);
const query = ref(false);
const picked = ref<XYZ>([0, 0, 0]);
const display = ref<'points' | 'original' | 'cache' | 'lod'>('points');
const displayLabel = ref('中心点预览');
const loadingDisplay = ref(false);
const clipEnabled = ref(false);
const clipMin = ref<XYZ>([0, 0, 0]);
const clipMax = ref<XYZ>([0, 0, 0]);
const boxEnabled = ref(false);
const boxCenter = ref<XYZ>([0, 0, 0]);
const boxSize = ref<XYZ>([1, 1, 1]);
const clipHelpersVisible = ref(true);
const axesVisible = ref(false);
const originPlanes = ref({ xoy: { visible: false, side: 0 }, xoz: { visible: false, side: 0 }, yoz: { visible: false, side: 0 } });
let engine: SingleModelEngine | null = null;
let controller: AbortController | null = null;
function fit() { engine?.fit(); }
function toggleQuery() { query.value = !query.value; engine?.setQueryEnabled(query.value); }
async function copyPoint() {
  await navigator.clipboard.writeText(picked.value.join(', '));
}
async function showDisplay(next: 'points' | 'original' | 'cache') {
  if (!engine || loadingDisplay.value) return;
  loadingDisplay.value = true; error.value = '';
  try {
    if (next === 'points') engine.showPoints();
    else {
      const url = next === 'original' ? props.originalUrl : props.cacheUrl;
      if (!url) throw new Error('该显示资源尚未就绪');
      await engine.showGaussian(url, next === 'original' ? (props.originalFilename ?? 'model.ply') : 'lod-meta.json');
    }
    display.value = next;
    displayLabel.value = next === 'points' ? '中心点预览' : next === 'original' ? '原始 Gaussian' : '流式缓存';
    applyClip();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { loadingDisplay.value = false; }
}
async function showLod(index: number) {
  const lod = props.lods?.[index];
  if (!lod || !engine || loadingDisplay.value) return;
  loadingDisplay.value = true; error.value = '';
  try {
    await engine.showGaussian(lod.gaussian_url, lod.name);
    display.value = 'lod'; displayLabel.value = `LOD ${index}：${lod.name}`; applyClip();
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { loadingDisplay.value = false; }
}
function applyClip() { engine?.setAxisClip(clipEnabled.value, clipMin.value, clipMax.value); }
function applyBox() { engine?.setBoxClip(boxEnabled.value, boxCenter.value, boxSize.value); }
function applyClipHelpers() { engine?.setClipHelpersVisible(clipHelpersVisible.value); }
function applyAxes() { engine?.setAxesVisible(axesVisible.value); }
function applyOrigin(plane: 'xoy' | 'xoz' | 'yoz') {
  const state = originPlanes.value[plane]; engine?.setOriginPlane(plane, state.visible, state.side);
}

watch([() => props.url, canvas], async ([url, canvasElement]) => {
  controller?.abort();
  engine?.destroy(); engine = null; ready.value = false;
  if (!url || !canvasElement) return;
  const current = new AbortController();
  controller = current; error.value = '';
  try {
    const cloud = await loadPreview(url, current.signal);
    if (current.signal.aborted || canvas.value !== canvasElement) return;
    engine = new SingleModelEngine(canvasElement, cloud, props.origin, props.transform,
      point => { picked.value = point; },
      values => {
        clipMin.value = [...values.axisMin]; clipMax.value = [...values.axisMax];
        boxCenter.value = [...values.boxCenter]; boxSize.value = [...values.boxSize];
      },
      tool => { query.value = tool === 'coordinate-query'; });
    engine.pickEnabled = query.value;
    engine.setClipHelpersVisible(clipHelpersVisible.value);
    ready.value = true;
    clipMin.value = [cloud.min.x, cloud.min.y, cloud.min.z];
    clipMax.value = [cloud.max.x, cloud.max.y, cloud.max.z];
    boxCenter.value = [(cloud.min.x + cloud.max.x) / 2, (cloud.min.y + cloud.max.y) / 2, (cloud.min.z + cloud.max.z) / 2];
    boxSize.value = [Math.max(cloud.max.x - cloud.min.x, 0.001), Math.max(cloud.max.y - cloud.min.y, 0.001), Math.max(cloud.max.z - cloud.min.z, 0.001)];
    applyClip(); applyBox(); applyAxes();
    for (const plane of ['xoy', 'xoz', 'yoz'] as const) applyOrigin(plane);
  } catch (reason) {
    if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : String(reason);
  }
}, { immediate: true, flush: 'post' });
watch(() => props.transform, value => engine?.applyTransform(value), { deep: true });
onUnmounted(() => { controller?.abort(); engine?.destroy(); });
</script>

<template>
  <div class="viewport">
    <canvas ref="canvas" aria-label="单模型三维预览"></canvas>
    <button type="button" @click="fit">适配视角</button>
    <button type="button" class="query-button" :aria-pressed="query" @click="toggleQuery">{{ query ? '退出坐标查询' : '坐标查询' }}</button>
    <div class="display-controls">
      <button type="button" :disabled="!ready || loadingDisplay" @click="showDisplay('points')">中心点</button>
      <button type="button" :disabled="!ready || loadingDisplay || !originalUrl" @click="showDisplay('original')">原始 Gaussian</button>
      <button type="button" :disabled="!ready || loadingDisplay || !cacheUrl" @click="showDisplay('cache')">流式缓存</button>
      <select v-if="lods?.length" aria-label="显示 LOD" :disabled="!ready || loadingDisplay" @change="showLod(Number(($event.target as HTMLSelectElement).value))">
        <option value="">选择已有 LOD</option><option v-for="(lod, index) in lods" :key="lod.gaussian_url" :value="index">LOD {{ index }}：{{ lod.name }}</option>
      </select>
      <strong>{{ loadingDisplay ? '加载中' : displayLabel }}</strong>
    </div>
    <details class="clip-controls">
      <summary>坐标轴剖切</summary>
      <label><input v-model="clipEnabled" type="checkbox" @change="applyClip">启用剖切</label>
      <div v-for="(_, index) in clipMin" :key="index">
        <span>{{ ['X', 'Y', 'Z'][index] }}</span>
        <input v-model.number="clipMin[index]" type="number" step="any" @change="applyClip">
        <input v-model.number="clipMax[index]" type="number" step="any" @change="applyClip">
      </div>
      <hr>
      <label><input v-model="boxEnabled" type="checkbox" @change="applyBox">启用长方体剖切</label>
      <label><input v-model="clipHelpersVisible" type="checkbox" @change="applyClipHelpers">显示剖切辅助体与手柄</label>
      <div v-for="(_, index) in boxCenter" :key="`box-${index}`">
        <span>{{ ['X', 'Y', 'Z'][index] }}</span>
        <input v-model.number="boxCenter[index]" type="number" step="any" title="中心" @change="applyBox">
        <input v-model.number="boxSize[index]" type="number" min="0.001" step="any" title="尺寸" @change="applyBox">
      </div>
      <hr>
      <label><input v-model="axesVisible" type="checkbox" @change="applyAxes">显示模型坐标轴</label>
      <div v-for="plane in (['xoy', 'xoz', 'yoz'] as const)" :key="plane" class="origin-row">
        <label><input v-model="originPlanes[plane].visible" type="checkbox" @change="applyOrigin(plane)">显示 {{ plane.toUpperCase() }}</label>
        <select v-model.number="originPlanes[plane].side" :aria-label="`${plane.toUpperCase()} 原点剖切`" @change="applyOrigin(plane)">
          <option :value="0">不剖切</option><option :value="1">保留正侧</option><option :value="-1">保留负侧</option>
        </select>
      </div>
    </details>
    <div class="coordinate-result">
      <span>业务坐标</span>
      <input v-for="(_, index) in 3" :key="index" v-model.number="picked[index]" type="number" step="any" :aria-label="`业务坐标 ${['X','Y','Z'][index]}`">
      <button type="button" @click="copyPoint">复制</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.viewport { position: relative; width: 100%; height: min(62vh, 680px); min-height: 360px; overflow: hidden; background: #09121d; }
canvas { width: 100%; height: 100%; display: block; }
button { position: absolute; top: 12px; left: 12px; padding: 8px 12px; cursor: pointer; }
.query-button { left: 104px; }
.display-controls { position: absolute; top: 12px; right: 12px; display: flex; align-items: center; gap: 6px; padding: 6px; background: #17283ddd; }
.display-controls button { position: static; margin: 0; }
.clip-controls { position: absolute; top: 62px; right: 12px; width: 286px; padding: 10px; background: #17283ddd; }
.clip-controls label { display: block; margin: 8px 0; }
.clip-controls div { display: grid; grid-template-columns: 20px 1fr 1fr; gap: 6px; margin-top: 6px; }
.clip-controls input[type='number'] { min-width: 0; }
.clip-controls hr { border: 0; border-top: 1px solid #385574; margin: 10px 0; }
.clip-controls .origin-row { display: flex; grid-template-columns: none; justify-content: space-between; align-items: center; }
.coordinate-result { position: absolute; left: 12px; bottom: 12px; padding: 10px; background: #17283d; }
.coordinate-result { display: flex; align-items: center; gap: 6px; }
.coordinate-result input { width: 112px; }
.coordinate-result button { position: static; }
p { position: absolute; left: 12px; bottom: 8px; color: #ffb8ae; }
</style>
