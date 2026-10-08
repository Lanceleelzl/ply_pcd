<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { invertAffine, transformParametersMatrix, transformXYZ, type TransformParameters, type XYZ } from '../../coordinate-math';
import { loadPreview } from '../../point-cloud';
import { SingleModelEngine } from '../../engine/core/SingleModelEngine';
import CoordinateQueryPanel from './CoordinateQueryPanel.vue';

const props = defineProps<{ taskId: string; url: string; origin: XYZ; transform: TransformParameters;
  originalUrl?: string; originalFilename?: string; cacheUrl?: string;
  lods?: Array<{ name: string; gaussian_url: string }> }>();
const canvas = ref<HTMLCanvasElement | null>(null);
const toolbar = ref<HTMLElement | null>(null);
const toolbarBottom = ref(66);
const toolbarObserver = new ResizeObserver(entries => { toolbarBottom.value = entries[0].target.getBoundingClientRect().height + 24; });
watch(toolbar, (value, previous) => { if (previous) toolbarObserver.unobserve(previous); if (value) toolbarObserver.observe(value); }, { flush: 'post' });
const emit = defineEmits<{ notify: [message: string]; 'update:transform': [value: TransformParameters] }>();
const error = ref('');
watch(error, value => { if (value) emit('notify', value); });
const ready = ref(false);
const query = ref(false);
const referenceEditing = ref(false);
const picking = ref(false);
const capture = ref<{ point: XYZ; x: number; y: number } | null>(null);
const clipOpen = ref(false);
const clipSection = ref<'axis' | 'box' | 'origin'>('axis');
const picked = ref<XYZ>(transformXYZ(transformParametersMatrix(props.transform), [0, 0, 0]));
const selectionSerial = ref(0);
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
const sceneAxesVisible = ref(false);
const sceneAxesLabels = ref<Array<{ text: string; x: number; y: number; color: string }>>([]);
function toggleSceneAxes() { sceneAxesVisible.value = !sceneAxesVisible.value; engine?.setSceneAxesVisible(sceneAxesVisible.value); }
const originPlanes = ref({ xoy: { visible: false, side: 0 }, xoz: { visible: false, side: 0 }, yoz: { visible: false, side: 0 } });
let engine: SingleModelEngine | null = null;
let controller: AbortController | null = null;
function fit() { engine?.fit(); }
function northView(up: XYZ, north: XYZ) { engine?.northView(up, north); }
function toggleQuery() { referenceEditing.value = false; engine?.setQueryPicking(false); query.value = !query.value; if (query.value) clipOpen.value = false; engine?.setQueryEnabled(query.value); }
function togglePicking() { engine?.setQueryPicking(!picking.value); }
function locate(active: boolean) {
  referenceEditing.value = active; query.value = false; clipOpen.value = false; engine?.setQueryEnabled(active);
  engine?.setQueryPicking(active);
}
function rotate(index: number, angle: number) {
  const rotation = [...props.transform.rotation_degrees] as XYZ;
  rotation[index] = angle;
  emit('update:transform', { ...props.transform, rotation_degrees: rotation });
}
function toggleClip() { clipOpen.value = !clipOpen.value; if (clipOpen.value) { referenceEditing.value = false; query.value = false; engine?.setQueryEnabled(false); } }
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
function editClip(values: XYZ, index: number, event: Event, update: () => void) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  values[index] = value; update();
}
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
      point => { picked.value = point; selectionSerial.value++; },
      values => {
        clipMin.value = [...values.axisMin]; clipMax.value = [...values.axisMax];
        boxCenter.value = [...values.boxCenter]; boxSize.value = [...values.boxSize];
      },
      tool => { query.value = tool === 'coordinate-query' && !referenceEditing.value; if (tool !== 'coordinate-query') referenceEditing.value = false; },
      active => { picking.value = active; },
      value => { capture.value = value; },
      labels => { sceneAxesLabels.value = labels; });
    engine.setSceneAxesVisible(sceneAxesVisible.value);
    engine.setQueryPoint(picked.value);
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
watch(() => props.transform, (value, previous) => {
  if (previous) picked.value = transformXYZ(transformParametersMatrix(value), transformXYZ(invertAffine(transformParametersMatrix(previous)), picked.value));
  engine?.applyTransform(value);
}, { deep: true });
watch(picked, value => engine?.setQueryPoint(value), { deep: true });
onUnmounted(() => { toolbarObserver.disconnect(); controller?.abort(); engine?.destroy(); });
</script>

<template>
  <div class="viewport" :style="{ '--streaming-toolbar-bottom': `${toolbarBottom}px` }">
    <canvas ref="canvas" aria-label="单模型三维预览"></canvas>
    <span v-for="label in sceneAxesLabels" :key="label.text" class="scene-axis-label" :style="{ left: `${label.x}px`, top: `${label.y}px`, color: label.color }">{{ label.text }}</span>
    <div v-if="sceneAxesVisible" class="scene-origin-info">场景原点：X＝0，Y＝0，Z＝0</div>
    <div v-if="capture" class="capture-marker" :style="{ left: `${capture.x}px`, top: `${capture.y}px` }" aria-label="已捕捉模型点"></div>
    <div ref="toolbar" class="scene-toolbar">
    <button type="button" @click="fit">适配视角</button>
    <button type="button" :class="{ active: query }" :aria-pressed="query" @click="toggleQuery">坐标查询</button>
    <button type="button" :class="{ active: clipEnabled || boxEnabled }" :aria-expanded="clipOpen" @click="toggleClip">剖切</button>
    <button type="button" :class="{ active: sceneAxesVisible }" :aria-pressed="sceneAxesVisible" @click="toggleSceneAxes">场景原点／轴</button>
    <div class="display-controls">
      <button type="button" :class="{ active: display === 'points' }" :disabled="!ready || loadingDisplay" @click="showDisplay('points')">中心点</button>
      <button type="button" :class="{ active: display === 'original' }" :disabled="!ready || loadingDisplay || !originalUrl" @click="showDisplay('original')">原始高斯</button>
      <button type="button" :class="{ active: display === 'cache' }" :disabled="!ready || loadingDisplay || !cacheUrl" @click="showDisplay('cache')">流式缓存</button>
      <select v-if="lods?.length" aria-label="显示 LOD" :disabled="!ready || loadingDisplay" @change="showLod(Number(($event.target as HTMLSelectElement).value))">
        <option value="">选择已有 LOD</option><option v-for="(lod, index) in lods" :key="lod.gaussian_url" :value="index">LOD {{ index }}：{{ lod.name }}</option>
      </select>
      <strong>{{ loadingDisplay ? '加载中' : displayLabel }}</strong>
    </div>
    <slot name="navigation" />
    <div class="scene-task-actions"><slot name="task-actions" /></div>
    </div>
    <section v-if="clipOpen" class="floating-panel clip-controls">
      <header><h3>显示剖切</h3><button @click="clipOpen = false" aria-label="关闭剖切">×</button></header>
      <p class="muted">仅影响单模型预览，不改变生成数据。</p>
      <div class="clip-section-switch" role="group" aria-label="剖切设置">
        <button v-for="section in (['axis', 'box', 'origin'] as const)" :key="section" type="button"
          :class="{ active: clipSection === section }" :aria-pressed="clipSection === section" @click="clipSection = section">
          {{ section === 'axis' ? '坐标轴' : section === 'box' ? '长方体' : '原点平面' }}
        </button>
      </div>
      <div v-show="clipSection === 'axis'" class="clip-section">
      <h4>坐标轴剖切</h4>
      <label><input v-model="clipEnabled" type="checkbox" @change="applyClip">启用剖切</label>
      <div class="clip-column-labels"><span></span><span>最小</span><span>最大</span></div>
      <div v-for="(_, index) in clipMin" :key="index">
        <span>{{ ['X', 'Y', 'Z'][index] }}</span>
        <input :value="clipMin[index].toFixed(3)" type="number" step="any" :aria-label="`${['X', 'Y', 'Z'][index]} 最小剖切边界`" @change="editClip(clipMin, index, $event, applyClip)">
        <input :value="clipMax[index].toFixed(3)" type="number" step="any" :aria-label="`${['X', 'Y', 'Z'][index]} 最大剖切边界`" @change="editClip(clipMax, index, $event, applyClip)">
      </div>
      </div>
      <div v-show="clipSection === 'box'" class="clip-section">
      <h4>长方体剖切</h4>
      <label><input v-model="boxEnabled" type="checkbox" @change="applyBox">启用长方体剖切</label>
      <label><input v-model="clipHelpersVisible" type="checkbox" @change="applyClipHelpers">显示剖切辅助体与手柄</label>
      <div class="clip-column-labels"><span></span><span>中心</span><span>尺寸</span></div>
      <div v-for="(_, index) in boxCenter" :key="`box-${index}`">
        <span>{{ ['X', 'Y', 'Z'][index] }}</span>
        <input :value="boxCenter[index].toFixed(3)" type="number" step="any" title="中心" @change="editClip(boxCenter, index, $event, applyBox)">
        <input :value="boxSize[index].toFixed(3)" type="number" min="0.001" step="any" title="尺寸" @change="editClip(boxSize, index, $event, applyBox)">
      </div>
      </div>
      <div v-show="clipSection === 'origin'" class="clip-section">
      <h4>模型原点与平面</h4>
      <label><input v-model="axesVisible" type="checkbox" @change="applyAxes">显示模型坐标轴</label>
      <div v-for="plane in (['xoy', 'xoz', 'yoz'] as const)" :key="plane" class="origin-row">
        <label><input v-model="originPlanes[plane].visible" type="checkbox" @change="applyOrigin(plane)">显示 {{ plane.toUpperCase() }}</label>
        <select v-model.number="originPlanes[plane].side" :aria-label="`${plane.toUpperCase()} 原点剖切`" @change="applyOrigin(plane)">
          <option :value="0">不剖切</option><option :value="1">保留正侧</option><option :value="-1">保留负侧</option>
        </select>
      </div>
      </div>
    </section>
    <section v-show="query" class="floating-panel coordinate-result"><header><h3>坐标查询</h3><button @click="toggleQuery" aria-label="关闭坐标查询">×</button></header><CoordinateQueryPanel :task-id="taskId" :picking="picking" :reference-editing="referenceEditing" :selection-serial="selectionSerial" :transform="transform" v-model:point="picked" @pick="togglePicking" @locate="locate" @rotate="rotate" @north="northView" @notify="emit('notify', $event)" /></section>
  </div>
</template>

<style scoped>
.viewport { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #09121d; }
.scene-axis-label { position: absolute; transform: translate(8px, -50%); padding: 2px 4px; border-radius: 3px; background: #09121dc9; font: 12px ui-monospace, Consolas, monospace; pointer-events: none; }
.scene-origin-info { position: absolute; bottom: 12px; right: 12px; padding: 6px 10px; border: 1px solid #3a4c63; border-radius: 6px; background: #0d1724e8; color: #adbed2; font-size: 12px; pointer-events: none; }
.capture-marker { position: absolute; width: 14px; height: 14px; box-sizing: border-box; border: 2px solid #6fffd0; border-radius: 50%; background: #09291cb3; box-shadow: 0 0 0 2px #08111d, 0 0 12px #6fffd0; transform: translate(-50%, -50%); pointer-events: none; }
canvas { width: 100%; height: 100%; display: block; }
.scene-toolbar { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px; border: 1px solid #3a4c63; border-radius: 10px; background: #0d1724e8; width: fit-content; max-width: calc(100% - 36px); }
.display-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.display-controls select { width: auto; max-width: 200px; }
.clip-controls label { display: block; margin: 8px 0; }
.clip-controls .clip-section-switch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 12px 0; }
.clip-controls .clip-section-switch button { min-width: 0; padding-inline: 4px; }
.clip-controls .clip-section > div:not(.origin-row) { display: grid; grid-template-columns: 20px 1fr 1fr; gap: 6px; margin-top: 6px; }
.clip-controls input[type='number'] { min-width: 0; }
.clip-controls .origin-row { display: flex; gap: 8px; justify-content: space-between; align-items: center; }
</style>
