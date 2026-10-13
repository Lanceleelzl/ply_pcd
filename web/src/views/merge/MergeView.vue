<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { createMerge, downloadMerge, listMerges, loadMerge, loadMergeOrigin, previewMergeCoordinates, convertMergeCoordinates, saveMergeOrigin, resetMergeOrigin, loadMergePreview,
  loadMergedPreview, mergeLodUrl, mergedLodUrl, saveMergeRegions, startMerge, cancelMerge, type MergeTask, type Region,
  type LegacyRegion, type RegionAction, type MergeModelSetting } from '../../api/merge-api';
import { readPlyHeader, type PlyHeader } from './ply-header';
import MergeViewport from './MergeViewport.vue';
import ModuleTopbar from '../../components/ModuleTopbar.vue';
import type { ModelCoordinates } from '../../api/merge-api';

const route = useRoute();
const router = useRouter();
const workspace = useWorkspaceStore();
const inputs = ref<File[][]>([[], []]);
const headers = ref<PlyHeader[][]>([[], []]);
const coordinates = ref<ModelCoordinates[]>([
  { epsg: '', offset: ['', '', ''], confirmed: false },
  { epsg: '', offset: ['', '', ''], confirmed: false },
]);
const coordinateWgs84 = ref<(number[] | null)[]>([null, null]);
const coordinatePreviewError = ref<string[]>(['', '']);
let coordinatePreviewTimer: ReturnType<typeof setTimeout> | undefined;
let coordinatePreviewVersion = 0;
function coordinateComplete(item: ModelCoordinates): boolean {
  return /^\d{1,6}$/.test(item.epsg) && Number(item.epsg) > 0 &&
    item.offset.every(value => value.trim() !== '' && Number.isFinite(Number(value)));
}
watch(coordinates, () => {
  const version = ++coordinatePreviewVersion;
  if (coordinatePreviewTimer) clearTimeout(coordinatePreviewTimer);
  coordinateWgs84.value = coordinates.value.map(() => null);
  coordinatePreviewError.value = coordinates.value.map(() => '');
  coordinatePreviewTimer = setTimeout(async () => {
    await Promise.all(coordinates.value.map(async (item, index) => {
      if (!coordinateComplete(item)) return;
      try {
        const result = await previewMergeCoordinates(item.epsg, item.offset);
        if (version === coordinatePreviewVersion) coordinateWgs84.value[index] = result;
      } catch (error) {
        if (version === coordinatePreviewVersion) coordinatePreviewError.value[index] =
          String(error).includes('合并任务不存在') ? '坐标换算服务尚未更新，请重启本地服务' :
            '坐标换算失败，请检查 EPSG 与投影坐标';
      }
    }));
  }, 300);
}, { deep: true });
const targetModel = ref(0);
const task = ref<MergeTask | null>(null);
const sceneViewport = ref<InstanceType<typeof MergeViewport> | null>(null);
const history = ref<MergeTask[]>([]);
const samples = ref<number[][][]>([]);
const mergedSamples = ref<number[][][]>([]);
const regions = ref<Region[]>([]);
const persistedRegions = ref<Region[]>([]);
const boundaryDirty = computed(() => JSON.stringify(regions.value) !== JSON.stringify(persistedRegions.value));
const previewTrimmed = ref<boolean[]>([]);
const gaussianLoading = ref<boolean[]>([]);
const corrections = ref<number[][]>([]);
const rotations = ref<number[][]>([]);
const modelSettings = ref<MergeModelSetting[]>([]);
const unitsConfirmed = computed(() => modelSettings.value.length > 0 && modelSettings.value.every(item =>
  item.confirmed && typeof item.scale === 'number' && Number.isFinite(item.scale) && item.scale > 0));
const operationHint = computed(() => {
  if (mergedPreview.value) return '';
  if (drawingMode.value) return '逐点绘制边界；靠近其他边界的端点、中点或边线可吸附。点击起点或按 Enter 闭合。';
  if (editingRegion.value && activeRegion.value !== null)
    return '拖动顶点调整边界，点击边线插入顶点；选中顶点后点击「−」或按 Delete 删除。Ctrl+Z／Ctrl+Y 仅撤销恢复当前边界的顶点操作。';
  if (selectedModel.value >= 0 && selectedModel.value !== targetModel.value)
    return '拖动场景手柄移动或旋转当前模型；切换模型时自动保存校正，按 Esc 退出选中。';
  const loadingModel = gaussianLoading.value.findIndex(Boolean);
  if (loadingModel >= 0) return `模型 ${loadingModel + 1} 的 Gaussian LOD 正在加载；点云会保留到加载完成。`;
  return '';
});
const drawing = ref<[number, number][]>([]);
const regionPanel = ref(false);
const activeRegion = ref<number | null>(null);
const editingRegion = ref(false);
const busy = ref(false);
const message = ref('');
const createPhase = ref<'idle' | 'preparing' | 'uploading' | 'processing' | 'loading' | 'error'>('idle');
const uploadLoaded = ref(0);
const uploadTotal = ref<number | null>(null);
const createError = ref('');
const previewLoading = ref(false);
const uploadPercent = computed(() => uploadTotal.value ? Math.min(100, Math.floor(uploadLoaded.value / uploadTotal.value * 100)) : null);
function uploadSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const createStatus = computed(() => {
  if (createPhase.value === 'preparing') return '正在准备上传请求…';
  if (createPhase.value === 'uploading') return `正在上传文件：${uploadSize(uploadLoaded.value)}${uploadTotal.value
    ? `／${uploadSize(uploadTotal.value)}（${uploadPercent.value}%）` : ''}`;
  if (createPhase.value === 'processing') return '文件已上传，服务端正在保存、校验 PLY 并创建任务…';
  if (createPhase.value === 'loading') return '任务已创建，正在加载三维场景…';
  return '';
});
const received = ref(0);
const mergedPreview = ref(false);
const mergedSource = ref<'ply' | 'streamed'>('ply');
const mergedDisplay = ref<'points' | 'gaussian'>('points');
const previewLevel = ref(0);
const modelDisplays = ref<('points' | 'gaussian')[]>([]);
const gaussianLevels = ref<number[]>([]);
const drawingMode = ref(false);
const selectedModel = ref(-1);
const visibleModels = ref<boolean[]>([]);
const selectedVertex = ref<number | null>(null);
const selectedLevels = ref<number[]>([]);
const originMode = ref<'projected' | 'wgs84'>('projected');
const originEpsg = ref('');
const originProjected = ref<string[]>(['', '', '']);
const originWgs84 = ref<string[]>(['', '', '']);
const originPoint = ref<number[] | null>(null);
const vertexMode = ref<'scene' | 'projected' | 'wgs84'>('scene');
const vertexInputs = ref<[string, string][]>([]);
const vertexInputError = ref('');
const vertexConverting = ref(false);
let vertexInputVersion = 0;
const undoVertices: [number, number][][] = [];
const redoVertices: [number, number][][] = [];
let vertexDragChanged = false;
let correctionsDirty = false;
let savePromise: Promise<void> | null = null;
let saveQueued = false;
let timer: ReturnType<typeof setInterval> | undefined;
let messageTimer: ReturnType<typeof setTimeout> | undefined;
watch(message, value => {
  if (messageTimer) clearTimeout(messageTimer);
  if (value) messageTimer = setTimeout(() => { message.value = ''; }, value.includes('Error') || value.includes('失败') ? 10000 : 5000);
});
async function refreshOrigin() {
  if (!task.value) return;
  const origin = await loadMergeOrigin(task.value.task_id);
  originEpsg.value = origin.epsg;
  originPoint.value = origin.projected;
  originProjected.value = origin.projected?.map(value => value.toFixed(4)) ?? ['', '', ''];
  originWgs84.value = origin.wgs84?.map((value, index) => value.toFixed(index === 2 ? 4 : 10)) ?? ['', '', ''];
}
watch([activeRegion, vertexMode, regions, originEpsg, originPoint], async () => {
  const version = ++vertexInputVersion;
  const polygon = activeRegion.value === null ? null : regions.value[activeRegion.value]?.polygon;
  vertexInputError.value = '';
  vertexConverting.value = false;
  if (!polygon) { vertexInputs.value = []; return; }
  if (vertexMode.value === 'scene') {
    vertexInputs.value = polygon.map(point => [String(point[0]), String(point[1])]); return;
  }
  if (!originPoint.value || !originEpsg.value) {
    vertexInputs.value = []; vertexInputError.value = '请先设置目标模型的投影坐标原点'; return;
  }
  const projected = polygon.map(point => [point[0] + originPoint.value![0], point[1] + originPoint.value![1]] as [number, number]);
  try {
    if (vertexMode.value === 'wgs84') { vertexInputs.value = []; vertexConverting.value = true; }
    const values = vertexMode.value === 'projected' ? projected :
      await convertMergeCoordinates(originEpsg.value, 'projected', projected);
    if (version === vertexInputVersion) vertexInputs.value = values.map(point =>
      [point[0].toFixed(vertexMode.value === 'wgs84' ? 10 : 4), point[1].toFixed(vertexMode.value === 'wgs84' ? 10 : 4)]);
  } catch (error) { if (version === vertexInputVersion) vertexInputError.value = String(error); }
  finally { if (version === vertexInputVersion) vertexConverting.value = false; }
}, { deep: true, immediate: true });
async function applyVertexInput(index: number) {
  const raw = vertexInputs.value[index];
  const region = activeRegion.value === null ? null : regions.value[activeRegion.value];
  if (!raw || !region?.polygon[index]) return;
  const values = raw.map(value => value.trim() === '' ? NaN : Number(value)) as [number, number];
  if (values.some(value => !Number.isFinite(value))) { vertexInputError.value = '请输入完整、有效的坐标'; return; }
  try {
    let scene = values;
    if (vertexMode.value !== 'scene') {
      if (!originPoint.value || !originEpsg.value) throw new Error('请先设置目标模型的投影坐标原点');
      const projected = vertexMode.value === 'projected' ? values :
        (await convertMergeCoordinates(originEpsg.value, 'wgs84', [values]))[0];
      if (!projected) throw new Error('坐标转换失败');
      scene = [projected[0] - originPoint.value[0], projected[1] - originPoint.value[1]];
    }
    if (scene.some(value => !Number.isFinite(value))) throw new Error('坐标转换结果无效');
    if (scene[0] !== region.polygon[index][0] || scene[1] !== region.polygon[index][1]) {
      snapshotVertices(); region.polygon[index] = scene;
    }
    vertexInputError.value = '';
  } catch (error) { vertexInputError.value = String(error); }
}
async function applyOrigin() {
  if (!task.value) return;
  const values = (originMode.value === 'projected' ? originProjected.value : originWgs84.value).map(Number);
  const raw = originMode.value === 'projected' ? originProjected.value : originWgs84.value;
  if (raw.some(value => !value.trim()) || values.some(value => !Number.isFinite(value))) {
    message.value = '坐标输入无效'; return;
  }
  try {
    await saveMergeOrigin(task.value.task_id, originEpsg.value, originMode.value, values);
    task.value = await loadMerge(task.value.task_id);
    await refreshOrigin();
    mergedPreview.value = false;
    message.value = '目标地理锚点已更新，模型相对位置未改变';
  } catch (error) { message.value = String(error); }
}
async function resetOrigin() {
  if (!task.value || busy.value) return;
  busy.value = true;
  try {
    await resetMergeOrigin(task.value.task_id);
    task.value = await loadMerge(task.value.task_id);
    await refreshOrigin();
    mergedPreview.value = false;
    message.value = '目标坐标已恢复为模型初始坐标';
  } catch (error) { message.value = String(error); }
  finally { busy.value = false; }
}
function onDrawingKey(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement) return;
  if (event.key === 'Escape') { selectedModel.value = -1; return; }
  if (event.key === 'Enter' && drawingMode.value && drawing.value.length >= 3) {
    event.preventDefault(); finishPolygon(); return;
  }
  if ((event.ctrlKey || event.metaKey) && (drawingMode.value || editingRegion.value)) {
    if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
      event.preventDefault(); restoreVertices(event.key.toLowerCase() === 'y' || event.shiftKey); return;
    }
  }
  if (event.key === 'Delete' && editingRegion.value && selectedVertex.value !== null) {
    event.preventDefault(); deleteVertex(selectedVertex.value);
  }
}
function currentVertices(): [number, number][] | null {
  return drawingMode.value ? drawing.value : editingRegion.value && activeRegion.value !== null
    ? regions.value[activeRegion.value]?.polygon ?? null : null;
}
function snapshotVertices() {
  const vertices = currentVertices();
  if (!vertices) return;
  undoVertices.push(vertices.map(point => [...point] as [number, number]));
  if (undoVertices.length > 100) undoVertices.shift();
  redoVertices.length = 0;
}
function restoreVertices(redo: boolean) {
  const stack = redo ? redoVertices : undoVertices;
  const previous = stack.pop();
  const current = currentVertices();
  if (!previous || !current) return;
  (redo ? undoVertices : redoVertices).push(current.map(point => [...point] as [number, number]));
  if (drawingMode.value) drawing.value = previous;
  else if (activeRegion.value !== null) regions.value[activeRegion.value].polygon = previous;
  selectedVertex.value = null;
}
function insertVertex(index: number, point: [number, number]) {
  const vertices = currentVertices();
  if (!vertices) return;
  snapshotVertices(); vertices.splice(index, 0, point);
  selectedVertex.value = index;
}
function deleteVertex(index: number) {
  const vertices = currentVertices();
  if (!vertices || vertices.length <= 3) return;
  snapshotVertices(); vertices.splice(index, 1);
  selectedVertex.value = null;
}
const colors = ['#65d9b4', '#f4aa6a', '#8bbdff', '#da9ef7', '#ffe080', '#ff8eac', '#9ce1dc', '#d7bd96'];
function statusLabel(status: string | undefined): string {
  return ({ editing: '待合并', queued: '排队中', running: '处理中', cancelling: '正在终止', cancelled: '已终止', ready: '已完成', failed: '失败',
    not_selected: '未选择', not_requested: '未生成' } as Record<string, string>)[status ?? ''] ?? '未执行';
}
const canGenerate = computed(() => {
  const levels = task.value?.merged_lods?.map(item => item.level) ?? [];
  return task.value?.merge_status === 'ready' && levels.length > 0 &&
    levels.every((level, index) => index === 0 || level === levels[index - 1] + 1);
});
const preflightError = computed(() => {
  if (inputs.value.some((files, index) => !files.length || files.length !== inputs.value[0].length ||
    headers.value[index]?.length !== files.length)) return '请为每个模型选择数量相同的 LOD PLY，并等待坐标预读完成';
  const all = headers.value.flat();
  if (all.some(header => header.error)) return '请检查标出的 PLY 文件头问题';
  if (coordinates.value.some(item => (item.epsg !== '' || item.offset.some(value => value !== '')) && !coordinateComplete(item)))
    return '模型原点须填写有效 EPSG 和完整 XYZ；未知时全部留空';
  if (coordinatePreviewError.value.some(Boolean)) return '请检查模型原点的 EPSG 与投影坐标';
  if (coordinates.value.some((item, index) => coordinateComplete(item) && !coordinateWgs84.value[index]))
    return '正在转换模型原点坐标';
  const known = coordinates.value.filter(coordinateComplete).map(item => item.epsg);
  if (new Set(known).size > 1) return '模型原点的 EPSG 不一致';
  return '';
});
function displayOffset(offset: number[] | null): string {
  return offset?.map(value => value.toFixed(4)).join('／') ?? '未知（相对局部坐标）';
}
function normalizeRegion(region: Region | LegacyRegion, modelCount: number): Region {
  if (region.kind === 'per_model') return region;
  const actions: RegionAction[] = Array(modelCount).fill('none');
  if (region.kind === 'remove') actions[region.model] = 'remove_inside';
  else if (region.kind === 'keep') actions.forEach((_, index) => {
    if (index !== region.model) actions[index] = 'remove_inside';
  });
  else if ('models' in region && region.kind === 'clip') region.models.forEach(model => {
    actions[model] = region.side === 'inside' ? 'remove_outside' : 'remove_inside';
  });
  else if ('models' in region) actions.forEach((_, model) => {
    if (!region.models.includes(model))
      actions[model] = region.side === 'inside' ? 'remove_inside' : 'remove_outside';
  });
  return { kind: 'per_model', actions, polygon: region.polygon };
}
function cloneRegion(region: Region): Region {
  return { kind: 'per_model', actions: [...region.actions],
    polygon: region.polygon.map(point => [...point] as [number, number]) };
}
function cancelBoundaryChanges() {
  regions.value = persistedRegions.value.map(cloneRegion);
  drawing.value = [];
  drawingMode.value = false;
  activeRegion.value = null;
  editingRegion.value = false;
  selectedVertex.value = null;
  vertexDragChanged = false;
  undoVertices.length = 0;
  redoVertices.length = 0;
}
function relativeOffset(index: number): string {
  if (!task.value) return '';
  const source = task.value.models[index].offset;
  const origin = task.value.models[targetModel.value].offset;
  return source && origin ? source.map((value, axis) => (value - origin[axis]).toFixed(4)).join('／') : '未知，使用三维手柄匹配';
}
const gaussianUrls = computed(() => !task.value ? [] : mergedPreview.value
  ? [mergedSource.value === 'streamed' ? task.value.cache_url ?? '' : mergedLodUrl(task.value.task_id, previewLevel.value)]
  : task.value.models.map((_, index) => mergeLodUrl(task.value!.task_id, gaussianLevels.value[index] ?? 0, index)));
const gaussianFilenames = computed(() => mergedPreview.value && mergedSource.value === 'streamed'
  ? ['lod-meta.json'] : gaussianUrls.value.map((_, index) => `model-${index}.ply`));
function insidePolygon(polygon: [number, number][], x: number, y: number): boolean {
  let inside = false;
  let previous = polygon[polygon.length - 1];
  for (const current of polygon) {
    const [x1, y1] = previous, [x2, y2] = current;
    const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    if (Math.abs(cross) <= 1e-9 && Math.min(x1, x2) - 1e-9 <= x && x <= Math.max(x1, x2) + 1e-9 &&
        Math.min(y1, y2) - 1e-9 <= y && y <= Math.max(y1, y2) + 1e-9) return true;
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
    previous = current;
  }
  return inside;
}
function keepPreviewPoint(point: number[], model: number): boolean {
  for (const region of regions.value) {
    const action = region.actions[model];
    if (action === 'none') continue;
    const inside = insidePolygon(region.polygon, point[0], point[1]);
    if ((action === 'remove_inside' && inside) || (action === 'remove_outside' && !inside)) return false;
  }
  return true;
}
const sceneSamples = computed(() => mergedPreview.value ? mergedSamples.value :
  samples.value.map((points, index) => previewTrimmed.value[index]
    ? points.filter(point => keepPreviewPoint(point, index)) : points));
const sceneDisplays = computed(() => mergedPreview.value ? [mergedDisplay.value] : modelDisplays.value);
const sceneTranslations = computed<[number, number, number][]>(() => mergedPreview.value ? [[0, 0, 0]] : modelTranslations.value);
const sceneRotations = computed(() => mergedPreview.value ? [[1, 0, 0, 0]] : rotations.value);
const sceneAxes = computed(() => mergedPreview.value ? [modelSettings.value[targetModel.value]?.axes ?? [1, 2, 3]] :
  modelSettings.value.map(item => item.axes));
const sceneScales = computed(() => mergedPreview.value ? [modelFactor(targetModel.value)] :
  modelSettings.value.map((_, index) => modelFactor(index)));
const allTrimmed = computed(() => previewTrimmed.value.length > 0 && previewTrimmed.value.every(Boolean));
function toggleTrimmedAll() { previewTrimmed.value = previewTrimmed.value.map(() => !allTrimmed.value); }
function toggleMergedDisplay() {
  mergedDisplay.value = mergedDisplay.value === 'points' ? 'gaussian' : 'points';
  if (!mergedPreview.value) void showPreview(true);
}
function setGaussianLoading(index: number, loading: boolean) { gaussianLoading.value[index] = loading; }
const unitMeters = { m: 1, cm: 0.01, mm: 0.001 };
function modelFactor(index: number): number {
  const setting = modelSettings.value[index];
  const factor = setting ? unitMeters[setting.unit] * setting.scale : 1;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}
function changeModelRule(index: number) {
  modelSettings.value[index].confirmed = true;
  void save();
}
function preventNumberWheel(event: WheelEvent) {
  const input = event.currentTarget as HTMLInputElement;
  if (document.activeElement === input) input.blur();
}
const modelTranslations = computed<[number, number, number][]>(() => {
  if (!task.value) return [];
  const origin = task.value.models[targetModel.value]?.offset;
  return task.value.models.map((model, index) => (modelSettings.value[index]?.axes ?? [1, 2, 3]).map((fileAxis, projected) => {
    const fileIndex = Math.abs(fileAxis) - 1;
    const geo = origin && model.offset ? model.offset[projected] - origin[projected] : 0;
    return (corrections.value[index]?.[fileIndex] ?? 0) * Math.sign(fileAxis) * modelFactor(index) + geo;
  }) as [number, number, number]);
});
function addPoint(point: [number, number]) { snapshotVertices(); drawing.value.push(point); }
function startDrawing() {
  sceneViewport.value?.top();
  undoVertices.length = 0; redoVertices.length = 0; selectedVertex.value = null;
  drawing.value = [];
  drawingMode.value = true;
  editingRegion.value = false;
  activeRegion.value = null;
  regionPanel.value = true;
}
function editRegion(index: number) {
  sceneViewport.value?.top();
  undoVertices.length = 0; redoVertices.length = 0; selectedVertex.value = null;
  activeRegion.value = index;
  editingRegion.value = true;
  drawingMode.value = false;
  regionPanel.value = true;
}
function updateVertex(index: number, point: [number, number]) {
  if (activeRegion.value === null) return;
  const region = regions.value[activeRegion.value];
  if (!region || !region.polygon[index] ||
      (region.polygon[index][0] === point[0] && region.polygon[index][1] === point[1])) return;
  if (!vertexDragChanged) { snapshotVertices(); vertexDragChanged = true; }
  region.polygon[index] = point;
}
function endVertexEdit() { vertexDragChanged = false; }
function removeRegion(index: number) {
  regions.value.splice(index, 1);
  if (activeRegion.value === index) { activeRegion.value = null; editingRegion.value = false; }
  else if (activeRegion.value !== null && activeRegion.value > index) activeRegion.value--;
}
function moveModel(model: number, delta: [number, number, number]) {
  if (model === targetModel.value) return;
  correctionsDirty = true;
  modelSettings.value[model].axes.forEach((axis, projected) => {
    corrections.value[model][Math.abs(axis) - 1] += delta[projected] * Math.sign(axis) / modelFactor(model);
  });
}
function resetModelPosition(model: number) {
  if (!task.value || model === targetModel.value || busy.value) return;
  corrections.value[model] = [0, 0, 0];
  rotations.value[model] = [1, 0, 0, 0];
  correctionsDirty = true;
  void save();
}
function rotateVector(rotation: number[], point: number[]): number[] {
  const [w, x, y, z] = rotation;
  const cross = [2 * (y * point[2] - z * point[1]),
    2 * (z * point[0] - x * point[2]), 2 * (x * point[1] - y * point[0])];
  return [point[0] + w * cross[0] + y * cross[2] - z * cross[1],
    point[1] + w * cross[1] + z * cross[0] - x * cross[2],
    point[2] + w * cross[2] + x * cross[1] - y * cross[0]];
}
function rotateModel(model: number, delta: [number, number, number, number], pivot: [number, number, number]) {
  if (model === targetModel.value || !task.value) return;
  correctionsDirty = true;
  const translation = modelTranslations.value[model];
  const rotated = rotateVector(delta, translation.map((value, axis) => value - pivot[axis]))
    .map((value, axis) => value + pivot[axis]);
  const source = task.value.models[model].offset;
  const origin = task.value.models[targetModel.value].offset;
  modelSettings.value[model].axes.forEach((fileAxis, projected) => {
    const geo = source && origin ? source[projected] - origin[projected] : 0;
    corrections.value[model][Math.abs(fileAxis) - 1] = (rotated[projected] - geo) * Math.sign(fileAxis) / modelFactor(model);
  });
  const [a, b, c, d] = delta;
  const [w, x, y, z] = rotations.value[model];
  const next = [a * w - b * x - c * y - d * z, a * x + b * w + c * z - d * y,
    a * y - b * z + c * w + d * x, a * z + b * y - c * x + d * w];
  const length = Math.hypot(...next);
  rotations.value[model] = next.map(value => value / length);
}
async function selectModelCard(index: number) {
  if (busy.value || (selectedModel.value === index && !mergedPreview.value)) return;
  if (correctionsDirty) await save();
  if (mergedPreview.value) await showPreview(false);
  selectedModel.value = index;
  drawingMode.value = false;
  editingRegion.value = false;
}
function finishPolygon() {
  if (drawing.value.length < 3) { message.value = '至少绘制三个顶点'; return; }
  regions.value.push({ kind: 'per_model', actions: task.value?.models.map(() => 'none') ?? [], polygon: [...drawing.value] });
  activeRegion.value = regions.value.length - 1;
  drawing.value = [];
  drawingMode.value = false;
  editingRegion.value = true;
  undoVertices.length = 0; redoVertices.length = 0;
}
async function choose(model: number, event: Event) {
  inputs.value[model] = Array.from((event.target as HTMLInputElement).files ?? [])
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  headers.value[model] = [];
  const files = inputs.value[model];
  const values = await Promise.all(files.map(file => readPlyHeader(file).catch(error => ({
    epsg: '', offset: ['', '', ''] as [string, string, string], source: '', count: 0,
    format: '', fields: [], error: String(error),
  }))));
  if (inputs.value[model] === files) headers.value[model] = values;
  if (inputs.value[model] === files && values[0]) {
    const first = { epsg: values[0].epsg, offset: [...values[0].offset] as [string, string, string], confirmed: false };
    const consistent = coordinateComplete(first) && values.every(header => header.epsg === first.epsg &&
      header.offset.every((value, axis) => Number(value) === Number(first.offset[axis])));
    coordinates.value[model] = consistent ? first : { epsg: '', offset: ['', '', ''], confirmed: false };
  }
}
function move(model: number, index: number, step: number) {
  const files = inputs.value[model];
  [files[index], files[index + step]] = [files[index + step], files[index]];
  const details = headers.value[model];
  if (details.length === files.length)
    [details[index], details[index + step]] = [details[index + step], details[index]];
}
async function refresh() {
  const id = route.params.taskId;
  try {
    history.value = await listMerges(workspace.workspaceId);
    if (typeof id !== 'string') { task.value = null; return; }
    const previous = task.value?.task_id;
    const previousMergeStatus = task.value?.merge_status;
    const previousCacheStatus = task.value?.cache_status;
    task.value = await loadMerge(id);
    if (task.value.merge_status !== 'ready' || !task.value.merged_lods?.length) mergedPreview.value = false;
    if (previousMergeStatus && previousMergeStatus !== 'failed' && task.value.merge_status === 'failed')
      message.value = task.value.merge_error || 'PLY 合并失败';
    if (previousCacheStatus && previousCacheStatus !== 'failed' && task.value.cache_status === 'failed')
      message.value = task.value.cache_error || '流式生成失败';
    if (previous !== id) {
      persistedRegions.value = task.value.regions.map(region => cloneRegion(normalizeRegion(region, task.value!.models.length)));
      regions.value = persistedRegions.value.map(cloneRegion);
      targetModel.value = task.value.target_model ?? 0;
      selectedModel.value = -1;
      visibleModels.value = task.value.models.map(() => true);
      previewTrimmed.value = task.value.models.map(() => false);
      gaussianLoading.value = task.value.models.map(() => false);
      mergedSamples.value = [];
      mergedPreview.value = false;
      mergedSource.value = 'ply';
      mergedDisplay.value = 'points';
      modelDisplays.value = task.value.models.map(() => 'points');
      gaussianLevels.value = task.value.models.map(model => model.lods.length - 1);
      modelSettings.value = task.value.models.map(model => ({ axes: [...(model.axes ?? task.value!.axes)],
        unit: model.unit ?? 'm', scale: model.scale ?? 1, confirmed: true }));
      corrections.value = task.value.models.map(model => [...model.correction]);
      rotations.value = task.value.models.map(model => [...(model.rotation ?? [1, 0, 0, 0])]);
      selectedLevels.value = task.value.selected_levels ?? task.value.models[0].lods.map((_, level) => level);
      await refreshOrigin();
      samples.value = (await loadMergePreview(id)).models;
    }
    if (task.value.merge_status === 'ready' && task.value.merged_lods?.length &&
        (previous !== id || previousMergeStatus !== 'ready' ||
         !task.value.merged_lods.some(item => item.level === previewLevel.value)))
      previewLevel.value = task.value.merged_lods[task.value.merged_lods.length - 1].level;
  } catch (error) { message.value = String(error); }
}
async function create() {
  if (busy.value) return;
  busy.value = true; message.value = ''; createError.value = '';
  createPhase.value = 'preparing'; uploadLoaded.value = 0; uploadTotal.value = null;
  try {
    const created = await createMerge(workspace.workspaceId, inputs.value,
      targetModel.value, coordinates.value.map(item => ({ ...item, confirmed: coordinateComplete(item) })), progress => {
        if (progress.phase === 'processing') createPhase.value = 'processing';
        else {
          createPhase.value = 'uploading';
          uploadLoaded.value = progress.loaded;
          uploadTotal.value = progress.total;
        }
      });
    createPhase.value = 'loading';
    await router.push({ name: 'merge-task', params: { taskId: created.task_id } });
    await refresh();
  } catch (error) { createError.value = String(error); createPhase.value = 'error'; }
  finally { busy.value = false; }
}
function save(includeRegions = false): Promise<void> {
  if (!task.value) return Promise.resolve();
  if (savePromise && includeRegions) return savePromise.then(() => save(true));
  if (savePromise) { saveQueued = true; return savePromise; }
  savePromise = (async () => {
    busy.value = true; message.value = '';
    try {
      do {
        saveQueued = false;
        const saved = await saveMergeRegions(task.value!.task_id, includeRegions ? regions.value : persistedRegions.value, corrections.value, rotations.value,
          modelSettings.value[targetModel.value].axes, unitsConfirmed.value, targetModel.value, modelSettings.value);
        if (includeRegions) persistedRegions.value = saved.regions.map(region => cloneRegion(normalizeRegion(region, saved.models.length)));
        if (saveQueued) continue;
        task.value = saved;
        if (includeRegions) regions.value = persistedRegions.value.map(cloneRegion);
        corrections.value = saved.models.map(model => [...model.correction]);
        rotations.value = saved.models.map(model => [...(model.rotation ?? [1, 0, 0, 0])]);
        modelSettings.value = saved.models.map(model => ({ axes: [...(model.axes ?? saved.axes)],
          unit: model.unit ?? 'm', scale: model.scale ?? 1, confirmed: model.confirmed ?? Boolean(saved.units_confirmed) }));
        correctionsDirty = false;
        await refreshOrigin();
        samples.value = (await loadMergePreview(saved.task_id)).models;
        mergedPreview.value = false;
        message.value = includeRegions ? '边界规则与模型设置已保存' : '模型设置已保存';
      } while (saveQueued);
    } catch (error) { message.value = String(error); }
    finally { busy.value = false; savePromise = null; }
  })();
  return savePromise;
}
async function run(operation: 'merge' | 'generate') {
  if (!task.value) return;
  if (operation === 'merge' && task.value.merge_path &&
      !window.confirm('此任务已有合并记录。再次执行会创建新一轮成果；若模型位置与边界未变化，结果也不会变化。中途终止时，设置一致的旧成果可恢复下载。确定继续吗？')) return;
  busy.value = true; message.value = '';
  try { task.value = await saveMergeRegions(task.value.task_id, operation === 'merge' ? regions.value : persistedRegions.value, corrections.value, rotations.value,
    modelSettings.value[targetModel.value].axes, unitsConfirmed.value, targetModel.value, modelSettings.value);
    if (operation === 'merge') {
      persistedRegions.value = task.value.regions.map(region => cloneRegion(normalizeRegion(region, task.value!.models.length)));
      regions.value = persistedRegions.value.map(cloneRegion);
    }
    task.value = await startMerge(task.value.task_id, operation,
      operation === 'merge' ? selectedLevels.value : undefined); }
  catch (error) { message.value = String(error); }
  finally { busy.value = false; }
}
async function stopMerge() {
  if (!task.value || !window.confirm('确定终止当前合并任务吗？已完成的成果文件会保留。')) return;
  busy.value = true;
  try {
    task.value = await cancelMerge(task.value.task_id);
    message.value = '正在终止合并任务';
  } catch (error) { message.value = String(error); }
  finally { busy.value = false; }
}
async function download(kind: 'ply' | 'streamed', level?: number) {
  if (!task.value) return;
  busy.value = true; received.value = 0; message.value = '';
  try { await downloadMerge(task.value.task_id, kind, value => { received.value = value; }, level);
    message.value = level === undefined ? '下载完成' : `LOD ${level} 下载完成`; }
  catch (error) { message.value = String(error); }
  finally { busy.value = false; }
}
async function showPreview(merged: boolean, source: 'ply' | 'streamed' = 'ply') {
  if (!task.value || previewLoading.value) return;
  previewLoading.value = true;
  try {
    if (merged && source === 'streamed' && !task.value.cache_url) throw new Error('流式缓存尚未就绪');
    if (merged) mergedSamples.value = (await loadMergedPreview(task.value.task_id, previewLevel.value)).models;
    mergedSource.value = source;
    if (merged && source === 'streamed') mergedDisplay.value = 'gaussian';
    mergedPreview.value = merged;
    drawingMode.value = false;
  } catch (error) { message.value = String(error); }
  finally { previewLoading.value = false; }
}
async function swapDirection() {
  if (inputs.value.length !== 2) return;
  targetModel.value = 1 - targetModel.value;
  selectedModel.value = -1;
  if (task.value) await save();
}
watch(targetModel, () => { selectedModel.value = -1; });
watch(() => route.params.taskId, () => { void refresh(); });
onMounted(() => { window.addEventListener('keydown', onDrawingKey); void refresh(); timer = setInterval(() => {
  if (task.value && (['queued', 'running', 'cancelling'].includes(task.value.merge_status) ||
    ['queued', 'running'].includes(task.value.cache_status))) void refresh();
}, 3000); });
onUnmounted(() => { window.removeEventListener('keydown', onDrawingKey); if (timer) clearInterval(timer);
  if (messageTimer) clearTimeout(messageTimer); if (coordinatePreviewTimer) clearTimeout(coordinatePreviewTimer); });
</script>

<template>
  <main class="merge-page" :class="{ 'merge-task-page': task }">
    <ModuleTopbar title="高斯合并" mark="M"><template #actions><RouterLink to="/merge">新建任务</RouterLink></template></ModuleTopbar>
    <p v-if="message" role="status">{{ message }}</p>
    <section v-if="!task" class="merge-panel">
      <h2>选择模型</h2>
      <p>每个模型至少一份 Gaussian PLY。请按精细到粗略确认 LOD 顺序，最粗层用于预览，边界裁剪调整。</p>
      <p>合并方向：模型 {{ targetModel + 1 }} 为目标模型。地理原点未知时，以目标模型的文件原点作为相对参照。</p>
      <label>目标模型<select v-model.number="targetModel"><option v-for="(_, index) in inputs" :key="index" :value="index">模型 {{ index + 1 }}</option></select></label>
      <button v-if="inputs.length === 2" type="button" @click="swapDirection">交换方向</button>
      <div v-for="(files, model) in inputs" :key="model" class="model-input">
        <h3>模型 {{ model + 1 }}（{{ model === targetModel ? '目标模型' : '待合入模型' }}）</h3>
        <div class="model-input-content"><div class="model-files">
          <input type="file" accept=".ply" multiple @change="choose(model, $event)">
          <ol><li v-for="(file, index) in files" :key="file.name + index">LOD {{ index }}：{{ file.name }}
            <span v-if="headers[model]?.[index]">；{{ headers[model][index].count.toLocaleString() }} 点；{{ (file.size / 1024 / 1024).toFixed(1) }} MB
              <strong v-if="headers[model][index].error">；{{ headers[model][index].error }}</strong></span>
            <button type="button" :disabled="index === 0" @click="move(model, index, -1)">上移</button>
            <button type="button" :disabled="index === files.length - 1" @click="move(model, index, 1)">下移</button>
          </li></ol>
        </div><div v-if="headers[model]?.length" class="coordinate-preview">
          <div class="coordinate-table-scroll"><table><thead><tr><th>LOD</th><th>来源</th><th>EPSG</th><th>offsetx</th><th>offsety</th><th>offsetz</th><th>格式</th></tr></thead>
            <tbody><tr v-for="(header, index) in headers[model]" :key="index">
              <td>{{ index }}</td><td>{{ header.source || '未知' }}</td><td>{{ header.epsg || '—' }}</td>
              <td v-for="(value, axis) in header.offset" :key="axis" :title="value">{{ value ? Number(value).toFixed(4) : '—' }}</td><td>{{ header.format }}</td>
            </tr></tbody></table></div>
          <p v-if="headers[model].some(header => header.epsg !== headers[model][0].epsg ||
            header.offset.some((value, axis) => value !== headers[model][0].offset[axis]))" class="coordinate-warning">
            此模型各 LOD 的预读坐标不一致，请核实后填写模型原点。</p>
          <p class="coordinate-title">模型原点坐标</p>
          <div class="coordinate-origin-grid"><div class="coordinate-fields"><label>EPSG<input v-model.trim="coordinates[model].epsg" inputmode="numeric" placeholder="可留空"></label>
            <label v-for="(axis, index) in 'xyz'" :key="axis">{{ ['东 X', '北 Y', '高 Z'][index] }}
              <input v-model.trim="coordinates[model].offset[index]" inputmode="decimal" placeholder="可留空"></label></div>
            <div class="coordinate-wgs84"><span>WGS84 经纬度</span>
              <template v-if="coordinateWgs84[model]"><span>经度 {{ coordinateWgs84[model]![0].toFixed(10) }}°</span>
                <span>纬度 {{ coordinateWgs84[model]![1].toFixed(10) }}°</span>
                <span>高度 {{ coordinateWgs84[model]![2].toFixed(4) }} m</span></template>
              <span v-else-if="coordinatePreviewError[model]" class="coordinate-warning">{{ coordinatePreviewError[model] }}</span>
              <span v-else>填写完整投影坐标后显示</span>
            </div></div>
        </div></div>
      </div>
      <button type="button" :disabled="inputs.length >= 8" @click="inputs.push([]); headers.push([]); coordinates.push({ epsg: '', offset: ['', '', ''], confirmed: false })">增加模型</button>
      <button type="button" :disabled="inputs.length <= 2" @click="inputs.pop(); headers.pop(); coordinates.pop(); targetModel = Math.min(targetModel, inputs.length - 1)">移除末尾模型</button>
      <p v-if="preflightError">{{ preflightError }}</p>
      <button type="button" :disabled="busy || !!preflightError" @click="create">{{ busy && createPhase !== 'idle' ? '正在创建合并任务…' : '上传并创建合并任务' }}</button>
      <div v-if="createStatus || createError" class="create-progress" role="status" aria-live="polite">
        <span v-if="createStatus">{{ createStatus }}</span>
        <span v-if="createError" class="create-error">{{ createError }}</span>
        <progress v-if="createPhase === 'uploading' && uploadTotal" :value="uploadLoaded" :max="uploadTotal"></progress>
        <progress v-else-if="createPhase === 'preparing' || createPhase === 'uploading' || createPhase === 'processing' || createPhase === 'loading'"></progress>
      </div>
      <p>上传与合并结果会同时占用磁盘；合并前服务会检查至少具有输入 PLY 总大小的可用空间。</p>
      <h2>历史合并任务</h2><ul><li v-for="item in history" :key="item.task_id"><RouterLink :to="`/merge/${item.task_id}`">{{ item.task_id }}</RouterLink>：{{ item.merge_status === 'ready' ? '合并已完成' : statusLabel(item.merge_status) }}</li></ul>
    </section>
    <div v-else class="merge-workspace">
      <section class="merge-panel controls">
        <div v-for="(model, index) in task.models" :key="index" class="model-input"
          :class="{ selected: selectedModel === index }" @click.capture="selectModelCard(index)">
          <h3><span class="model-card-color" :style="{ backgroundColor: colors[index % colors.length] }"></span>模型 {{ index + 1 }}（{{ index === targetModel ? '目标模型' : '待合入模型' }}）</h3>
          <div class="model-coordinate-rules" @click.stop>
            <label>文件单位<select v-model="modelSettings[index].unit" @change="changeModelRule(index)"><option value="m">米</option><option value="cm">厘米</option><option value="mm">毫米</option></select></label>
            <label>放缩比例<input v-model.number="modelSettings[index].scale" type="number" min="0.000001" step="any" @wheel="preventNumberWheel" @change="changeModelRule(index)"></label>
            <label>上方向<select :value="modelSettings[index].axes[1] === -3 ? 'y' : 'z'" @change="modelSettings[index].axes = ($event.target as HTMLSelectElement).value === 'y' ? [1, -3, 2] : [1, 2, 3]; changeModelRule(index)">
              <option value="z">＋Z 向上</option><option value="y">＋Y 向上</option></select></label>
          </div>
          <p v-if="index !== targetModel">EPSG:{{ model.epsg || '未知' }}；投影原点：{{ displayOffset(model.offset) }}；{{ model.lods.length }} 层</p>
          <div v-if="index === targetModel" class="target-origin" @click.stop>
            <label>EPSG<input v-model.trim="originEpsg" inputmode="numeric" placeholder="投影 EPSG"></label>
            <div class="origin-mode"><button type="button" :class="{ active: originMode === 'projected' }" @click="originMode = 'projected'">投影 XYZ</button>
              <button type="button" :class="{ active: originMode === 'wgs84' }" @click="originMode = 'wgs84'">WGS84 经纬度</button></div>
            <div class="coordinate-fields"><label v-for="(label, axis) in originMode === 'projected' ? ['东 X', '北 Y', '高 Z'] : ['经度', '纬度', '高度']" :key="label">{{ label }}
              <input v-model="(originMode === 'projected' ? originProjected : originWgs84)[axis]" inputmode="decimal" placeholder="输入坐标"></label></div>
            <div class="target-origin-actions"><button type="button" :disabled="busy" @click="applyOrigin">应用</button>
              <button type="button" :disabled="busy" @click="resetOrigin">重置</button></div>
          </div>
          <p v-if="index !== targetModel">相对目标模型的投影差值（东／北／高）：{{ relativeOffset(index) }}</p>
          <label v-for="axis in index === targetModel ? 0 : 3" :key="axis" class="model-correction">{{ 'XYZ'[axis - 1] }} 位移（{{ { m: '米', cm: '厘米', mm: '毫米' }[modelSettings[index].unit] }}）
            <input v-model.number="corrections[index][axis - 1]" type="number" step="any" @wheel="preventNumberWheel" @change="save()"></label>
          <button v-if="index !== targetModel" type="button" class="reset-model-position" :disabled="busy ||
            (corrections[index]?.every(value => value === 0) && rotations[index]?.every((value, axis) => value === (axis === 0 ? 1 : 0)))"
            @click.stop="resetModelPosition(index)">重置位置</button>
        </div>
        <div class="merge-confirm">
          <h2>合并任务</h2>
          <label>合并目标<select v-model.number="targetModel" @change="save()"><option v-for="(_, index) in task.models" :key="index" :value="index">模型 {{ index + 1 }}</option></select></label>
          <div v-for="(lod, level) in task.models[0].lods" :key="level" class="merge-level">
            <label><input v-model="selectedLevels" type="checkbox" :value="level" :disabled="['queued', 'running', 'cancelling'].includes(task.merge_status)">LOD {{ level }}：{{ lod.name }}</label>
            <div class="merge-level-status"><span>{{ statusLabel(task.level_progress?.[level]?.status) }}<template v-if="task.level_progress?.[level]?.status === 'running' && task.level_progress[level].total">：{{ Math.floor(task.level_progress[level].processed / task.level_progress[level].total * 100) }}%</template></span>
              <button v-if="task.level_progress?.[level]?.status === 'ready' ||
                (task.merge_status === 'ready' && task.merged_lods?.some(item => item.level === level))"
                type="button" :disabled="busy || (task.merge_status !== 'ready' && !task.partial_lod_downloads)"
                :title="task.merge_status !== 'ready' && !task.partial_lod_downloads ? '当前服务待合并任务结束后更新，避免中断处理' : ''"
                @click="download('ply', level)">{{ task.merge_status !== 'ready' && !task.partial_lod_downloads ? '下载 PLY（待服务更新）' : '下载 PLY' }}</button></div>
            <progress v-if="task.level_progress?.[level]?.status === 'running'" :value="task.level_progress[level].processed" :max="task.level_progress[level].total || 1"></progress>
            <span v-if="task.merged_lods?.some(item => item.level === level)">{{ task.merged_lods.find(item => item.level === level)?.count.toLocaleString() }} 个高斯</span>
          </div>
          <button type="button" class="merge-workflow-action" :disabled="busy || ['queued', 'running', 'cancelling'].includes(task.merge_status) || !selectedLevels.length || !unitsConfirmed" @click="run('merge')">合并选中层级</button>
          <button v-if="['queued', 'running', 'cancelling'].includes(task.merge_status)" type="button" class="merge-workflow-action" :disabled="busy || task.merge_status === 'cancelling'" @click="stopMerge">{{ task.merge_status === 'cancelling' ? '正在终止…' : '终止任务' }}</button>
          <p>PLY 合并：{{ statusLabel(task.merge_status) }}</p>
        </div>
        <button type="button" class="merge-workflow-action" :disabled="busy || task.merge_status !== 'ready'" @click="download('ply')">下载合并成果集（zip）</button>
        <p v-if="task.merge_status === 'ready' && task.cache_status === 'not_requested'">PLY 已合并。流式数据不会自动生成，需要时请手动确认。</p>
        <button type="button" class="merge-workflow-action" :disabled="busy || !canGenerate || task.cache_status === 'running'" @click="run('generate')">生成LOD流式数据缓存</button>
        <p v-if="task.merge_status === 'ready' && !canGenerate">所选成果层级不连续，需合并连续层级后才能生成流式数据。</p>
        <p>流式生成：{{ statusLabel(task.cache_status) }}</p>
        <button type="button" class="merge-workflow-action" :disabled="busy || task.cache_status !== 'ready'" @click="download('streamed')">下载LOD流式数据缓存</button>
        <p v-if="received">已接收 {{ (received / 1024 / 1024).toFixed(1) }} MB</p>
      </section>
      <section class="merge-panel scene">
        <MergeViewport ref="sceneViewport" :samples="sceneSamples" :regions="mergedPreview ? [] : regions" :drawing="drawing" :selected="mergedPreview ? -1 : selectedModel"
          :target-model="targetModel" :drawing-mode="drawingMode && !mergedPreview"
          :displays="sceneDisplays" :gaussian-urls="gaussianUrls" :gaussian-filenames="gaussianFilenames" :trimmed="previewTrimmed"
          :model-translations="sceneTranslations" :model-rotations="sceneRotations"
          :model-axes="sceneAxes" :model-scales="sceneScales"
          :visible-models="mergedPreview ? [true] : visibleModels" :selected-vertex="selectedVertex"
          :operation-hint="operationHint"
          :editing-region="editingRegion && !mergedPreview ? activeRegion : null" @point="addPoint" @finish="finishPolygon"
          @vertex="updateVertex" @vertex-start="vertexDragChanged = false" @vertex-select="selectedVertex = $event"
          @vertex-insert="insertVertex" @vertex-delete="deleteVertex" @vertex-end="endVertexEdit" @move="moveModel" @rotate="rotateModel" @move-end="save()"
          @gaussian-loading="setGaussianLoading">
          <template #tools>
            <button type="button" :disabled="mergedPreview" @click="startDrawing">绘制边界</button>
            <button v-if="drawingMode" type="button" :disabled="drawing.length < 3" @click="finishPolygon">完成边界</button>
            <button v-if="drawingMode" type="button" @click="drawing = []; drawingMode = false">取消</button>
            <button type="button" :disabled="mergedPreview" @click="regionPanel = !regionPanel">边界管理（{{ regions.length }}）</button>
            <div class="scene-preview-section">
              <span class="scene-toolbar-divider" aria-hidden="true"></span>
              <div class="scene-preview-actions">
                <div class="scene-preview-action-group">
                  <span>原模型</span>
                  <button type="button" :disabled="mergedPreview || !regions.length" :aria-pressed="allTrimmed"
                    @click="toggleTrimmedAll">{{ allTrimmed ? '恢复' : '预览删减' }}</button>
                </div>
                <div v-if="task.merge_status === 'ready' && task.merged_lods?.length" class="scene-result-actions">
                  <span class="scene-toolbar-divider" aria-hidden="true"></span>
                  <div class="scene-preview-action-group">
                    <label for="merge-result-level">合并成果</label>
                    <select id="merge-result-level" v-model.number="previewLevel" aria-label="成果层级"
                      :disabled="previewLoading" @change="mergedPreview && showPreview(true, 'ply')">
                      <option v-for="level in task.merged_lods" :key="level.level" :value="level.level">LOD {{ level.level }}</option>
                    </select>
                    <button type="button" :disabled="previewLoading" :aria-pressed="mergedDisplay === 'gaussian'"
                      @click="toggleMergedDisplay">{{ mergedDisplay === 'gaussian' ? '点云' : '高斯' }}</button>
                    <button type="button" :disabled="previewLoading" @click="showPreview(!mergedPreview || mergedSource !== 'ply', 'ply')">{{ previewLoading ? '加载中…' : mergedPreview && mergedSource === 'ply' ? '返回' : '查看合并结果' }}</button>
                  </div>
                </div>
                <div v-if="task.cache_status === 'ready' && task.cache_url" class="scene-result-actions">
                  <span class="scene-toolbar-divider" aria-hidden="true"></span>
                  <div class="scene-preview-action-group">
                    <span>流式缓存</span>
                    <button type="button" :disabled="previewLoading" @click="showPreview(!mergedPreview || mergedSource !== 'streamed', 'streamed')">{{ previewLoading ? '加载中…' : mergedPreview && mergedSource === 'streamed' ? '返回' : '预览流式缓存' }}</button>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <template #preview-tools>
            <template v-if="!mergedPreview">
            <div v-for="(model, index) in task.models" :key="index" class="model-preview-row">
              <span class="model-preview-name"><span class="model-card-color" :style="{ backgroundColor: colors[index % colors.length] }"></span>模型 {{ index + 1 }}</span>
              <button type="button" :aria-pressed="visibleModels[index] !== false" :disabled="mergedPreview"
                @click="visibleModels[index] = visibleModels[index] === false">{{ visibleModels[index] === false ? '显示' : '隐藏' }}</button>
              <button type="button" :disabled="mergedPreview" @click="modelDisplays[index] = modelDisplays[index] === 'points' ? 'gaussian' : 'points'">{{ modelDisplays[index] === 'points' ? '高斯' : '点云' }}</button>
              <button type="button" :disabled="mergedPreview || !regions.length" @click="previewTrimmed[index] = !previewTrimmed[index]">{{ previewTrimmed[index] ? '恢复模型' : '预览删减' }}</button>
              <select v-if="modelDisplays[index] === 'gaussian'" v-model.number="gaussianLevels[index]"
                :aria-label="`模型 ${index + 1} Gaussian LOD 层级`" :disabled="mergedPreview">
                <option v-for="(lod, level) in model.lods" :key="level" :value="level">LOD {{ level }}：{{ lod.name }}</option>
              </select>
              <span v-if="gaussianLoading[index]" class="preview-loading">加载中…</span>
            </div>
            </template>
            <div v-if="mergedPreview" class="merged-preview-label">{{ mergedSource === 'streamed' ? '流式缓存' : `合并成果 · LOD ${previewLevel}` }} · {{ mergedDisplay === 'gaussian' ? '高斯' : '点云' }}<span v-if="mergedDisplay === 'gaussian' && gaussianLoading[0]"> · 加载中…</span></div>
            <small v-if="!mergedPreview && previewTrimmed.some(Boolean)" class="preview-note">点云与高斯按当前边界实时预览删减；合并按完整 PLY 执行。</small>
          </template>
          <template #panel><div v-if="regionPanel && !mergedPreview" class="region-editor"
            :style="{ top: `calc(${62 + task.models.length * 46}px + var(--merge-toolbar-extra, 0px))`, maxHeight: `calc(100% - ${78 + task.models.length * 46}px - var(--merge-toolbar-extra, 0px))` }">
            <ol><li v-for="(region, index) in regions" :key="index">
              <button type="button" :class="{ active: activeRegion === index && editingRegion }" @click="editRegion(index)">边界 {{ index + 1 }}（{{ region.polygon.length }} 点）</button>
              <button type="button" @click="removeRegion(index)">删除</button>
              <div v-if="activeRegion === index && editingRegion" class="region-detail">
                <div class="region-model-actions"><label v-for="(_, model) in task.models" :key="model">模型 {{ model + 1 }}
                  <select v-model="region.actions[model]"><option value="none">不处理</option><option value="remove_inside">删除边界内</option><option value="remove_outside">删除边界外</option></select></label></div>
                <label class="region-coordinate-mode">顶点坐标
                  <select v-model="vertexMode" aria-label="边界顶点坐标类型">
                    <option value="scene">场景 X／Y</option>
                    <option value="projected" :disabled="!originEpsg || !originPoint">源文件投影 东／北</option>
                    <option value="wgs84" :disabled="!originEpsg || !originPoint">WGS84 经／纬度</option>
                  </select>
                </label>
                <p v-if="vertexMode !== 'scene'" class="region-coordinate-hint">EPSG:{{ originEpsg }}；以目标模型原点换算，边界贯穿全部高度。</p>
                <div class="region-vertex-row region-vertex-header"><span>顶点</span><span>{{ vertexMode === 'wgs84' ? '经度' : vertexMode === 'projected' ? '投影东' : '场景 X' }}</span><span>{{ vertexMode === 'wgs84' ? '纬度' : vertexMode === 'projected' ? '投影北' : '场景 Y' }}</span></div>
                <p v-if="vertexConverting" class="region-coordinate-hint">正在换算坐标…</p>
                <div v-for="(point, vertex) in vertexInputs" :key="vertex" class="region-vertex-row">
                  <span>点 {{ vertex + 1 }}</span>
                  <input v-model="point[0]" :aria-label="`边界 ${index + 1} 顶点 ${vertex + 1} ${vertexMode === 'wgs84' ? '经度' : vertexMode === 'projected' ? '投影东' : '场景 X'}`" inputmode="decimal" @change="applyVertexInput(vertex)">
                  <input v-model="point[1]" :aria-label="`边界 ${index + 1} 顶点 ${vertex + 1} ${vertexMode === 'wgs84' ? '纬度' : vertexMode === 'projected' ? '投影北' : '场景 Y'}`" inputmode="decimal" @change="applyVertexInput(vertex)">
                </div>
                <p v-if="vertexInputError" class="coordinate-warning">{{ vertexInputError }}</p>
              </div>
            </li></ol>
            <p v-if="boundaryDirty">边界修改尚未保存，现有合并成果与下载保持原样。</p>
            <div class="region-editor-actions">
              <button type="button" :disabled="busy || !boundaryDirty" @click="save(true)">保存边界规则</button>
              <button type="button" :disabled="busy || (!boundaryDirty && !drawing.length)" @click="cancelBoundaryChanges">取消修改</button>
            </div>
          </div></template>
        </MergeViewport></section>
    </div>
  </main>
</template>

<style scoped>
.merge-page { min-height: 100vh; padding: 0; background: #08111d; color: #edf5ff; }
.merge-page:not(.merge-task-page) > .merge-panel { margin: 24px; }
.merge-task-page { height: 100vh; min-height: 0; padding: 0; display: flex; flex-direction: column; overflow: hidden; font-size: 14px; line-height: 1.45; }
.merge-task-page > [role=status] { position: absolute; z-index: 10; right: 16px; bottom: 16px; margin: 0; padding: 8px 12px; background: #173c32; border: 1px solid #4dbb92; border-radius: 6px; }
a { color: #78d6b8; } .merge-workspace { display: grid; grid-template-columns: minmax(340px, 420px) minmax(0, 1fr); gap: 16px; }
.merge-task-page .merge-workspace { flex: 1; min-height: 0; grid-template-columns: 320px minmax(0, 1fr); gap: 0; }
.merge-task-page .merge-panel { min-width: 0; min-height: 0; border: 0; border-radius: 0; }
.merge-task-page .controls { max-height: none; overflow: auto; padding: 12px; border-right: 1px solid #29394e; scrollbar-width: thin; scrollbar-color: #48617b #132235; }
.merge-task-page .controls::-webkit-scrollbar { width: 8px; }
.merge-task-page .controls::-webkit-scrollbar-track { background: #132235; }
.merge-task-page .controls::-webkit-scrollbar-thumb { border: 2px solid #132235; border-radius: 8px; background: #48617b; }
.merge-task-page .controls h2 { margin: 0 0 14px; font-size: 18px; line-height: 1.3; }
.merge-task-page .scene { position: relative; display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.merge-task-page .scene .merge-viewport { flex: 1; min-height: 0; }
.region-editor { position: absolute; z-index: 3; left: 12px; width: min(520px, calc(100% - 24px)); overflow: auto; padding: 12px; background: #17283df2; border: 1px solid #385574; border-radius: 8px; box-shadow: 0 12px 30px #0008; }
.region-editor ol { padding-left: 20px; } .region-editor li { margin: 8px 0; }
.region-model-actions { display: grid; gap: 6px; }
.region-model-actions label { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 6px; align-items: center; }
.region-model-actions select { min-width: 0; margin: 0; }
.region-detail { padding: 8px; background: #102036; }
.region-coordinate-mode { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.region-coordinate-hint { margin: 4px 0 8px; color: #adbed2; font-size: 12px; }
.region-vertex-row { display: grid; grid-template-columns: 46px minmax(0, 1fr) minmax(0, 1fr); gap: 6px; align-items: center; }
.region-vertex-header { color: #adbed2; font-size: 12px; }
.region-vertex-row input { width: 100%; min-width: 0; box-sizing: border-box; margin: 2px 0; font-size: 13px; }
.region-editor button.active { border-color: #65d9b4; color: #65d9b4; }
.region-editor-actions { display: flex; gap: 8px; }
.region-editor-actions button { flex: 1; min-width: 0; }
.merge-panel { padding: 20px; border: 1px solid #385574; border-radius: 12px; background: #17283d; }
.create-progress { display: grid; gap: 8px; max-width: 560px; margin: 10px 5px 16px; padding: 12px; border: 1px solid #385574; border-radius: 8px; background: #102036; color: #c7e8df; }
.create-progress progress { width: 100%; accent-color: #65d9b4; }
.create-error { color: #ffad9f; overflow-wrap: anywhere; }
.controls { max-height: calc(100vh - 110px); overflow: auto; } .model-input { padding: 12px; border: 1px solid #385574; margin: 12px 0; }
.merge-task-page .model-input { padding: 10px; margin: 8px 0; }
.merge-task-page .controls > .model-input:first-child { margin-top: 0; }
.model-input.selected { border-color: #65d9b4; }
.model-coordinate-rules { display: grid; gap: 2px; }
.reset-model-position { display: block; width: calc(100% - 16px); margin: 12px 8px 5px; }
.model-input h3 { display: flex; align-items: center; gap: 8px; }
.merge-task-page .model-input h3 { margin: 2px 0 8px; font-size: 16px; line-height: 1.35; }
.merge-task-page .model-input p { margin: 10px 0; color: #adbed2; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.merge-task-page .model-input button, .merge-task-page .model-input input,
.merge-task-page .model-input select { font-size: 14px; }
.model-card-color { display: inline-block; width: 12px; height: 12px; flex: none; border-radius: 50%; }
.model-preview-row { display: flex; align-items: center; gap: 8px; min-height: 38px; max-width: 100%; white-space: nowrap; }
.scene-preview-section { display: flex; align-items: center; gap: 8px; }
.scene-toolbar-divider { flex: none; width: 1px; height: 30px; margin: 0 4px; background: #49627b; }
.scene-preview-actions { display: flex; align-items: center; gap: 16px; min-height: 38px; }
.scene-result-actions { display: flex; align-items: center; gap: 8px; }
.scene-preview-action-group { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.scene-preview-action-group > span, .scene-preview-action-group > label { color: #a9c5da; font-size: 13px; }
.scene-preview-action-group > select { width: 92px; min-width: 0; margin: 0; }
.scene-preview-action-group > button { margin: 0; }
.scene-preview-action-group button[aria-pressed="true"] { border-color: #65d9b4; color: #65d9b4; }
.preview-loading, .preview-note { color: #a9c5da; font-size: 12px; }
.preview-note { padding: 0 4px; }
.merged-preview-label { padding: 8px 12px; border: 1px solid #65d9b4; border-radius: 6px; background: #173c32; color: #c7f5e6; }
.model-preview-name { display: inline-flex; align-items: center; gap: 6px; min-width: 76px; }
.model-preview-row button[aria-pressed="false"] { color: #9babc0; }
.target-origin { padding: 7px; margin-top: 6px; background: #102036; border-radius: 6px; }
.target-origin-actions { display: flex; gap: 4px; }
.target-origin-actions button { flex: 1; min-width: 0; margin: 4px 0; }
.origin-mode { display: flex; gap: 4px; }
.origin-mode button { flex: 1; min-width: 0; margin: 3px 0; padding: 6px 3px; font-size: 13px; white-space: nowrap; }
.origin-mode button.active { border-color: #65d9b4; color: #65d9b4; }
.merge-confirm { margin-top: 16px; padding: 12px; border: 1px solid #385574; border-radius: 8px; background: #102036; }
.merge-task-page .merge-confirm h2 { margin-bottom: 10px; }
.merge-task-page .merge-workflow-action { display: block; box-sizing: border-box; width: calc(100% - 10px); margin: 8px 5px; text-align: center; }
.merge-level { display: grid; gap: 4px; padding: 8px 0; border-top: 1px solid #385574; }
.merge-level progress { width: 100%; }
.merge-level-status { display: flex; align-items: center; gap: 8px; }
.merge-level-status button { margin: 0; padding: 3px 8px; font-size: 13px; }
.model-input label { display: inline-block; margin-right: 8px; } .model-input input[type=number] { width: 90px; appearance: textfield; -moz-appearance: textfield; }
.model-input input[type=number]::-webkit-inner-spin-button, .model-input input[type=number]::-webkit-outer-spin-button { margin: 0; -webkit-appearance: none; }
.model-input .model-coordinate-rules label { display: grid; grid-template-columns: 80px minmax(0, 1fr); align-items: center; min-width: 0; margin: 0; white-space: nowrap; }
.model-input .model-coordinate-rules select, .model-input .model-coordinate-rules input[type=number] { width: 100%; min-width: 0; box-sizing: border-box; margin: 2px 0; }
.model-input .target-origin > label { display: grid; grid-template-columns: 48px minmax(0, 1fr); align-items: center; margin: 0; }
.target-origin > label input { width: 100%; min-width: 0; box-sizing: border-box; margin: 2px 0; }
.model-input .coordinate-fields label { display: grid; grid-template-columns: 48px minmax(0, 1fr); align-items: center; margin: 0; white-space: nowrap; }
.model-input .coordinate-fields input { width: 100%; min-width: 0; box-sizing: border-box; margin: 2px 0; }
.model-input .model-correction { display: grid; grid-template-columns: 112px minmax(0, 1fr); align-items: center; margin: 2px 0; font-size: 13px; white-space: nowrap; }
.model-input .model-correction input[type=number] { width: 100%; min-width: 0; box-sizing: border-box; margin: 2px 0; }
.model-input-content { display: grid; grid-template-columns: minmax(0, 9fr) minmax(0, 11fr); align-items: start; gap: 16px; }
.model-input-content:not(:has(.coordinate-preview)) { grid-template-columns: 1fr; }
.model-files { min-width: 0; }
.model-files input[type=file] { margin-top: 0; }
.model-files ol { padding-left: 24px; }
.coordinate-preview { min-width: 0; padding: 8px 12px; border-left: 3px solid #65d9b4; background: #102036; }
.coordinate-table-scroll { max-width: 100%; overflow-x: auto; }
.coordinate-preview table { width: 100%; border-collapse: collapse; font-size: 12px; }
.coordinate-preview th, .coordinate-preview td { padding: 6px; border-bottom: 1px solid #385574; text-align: left; white-space: nowrap; }
.coordinate-title { margin: 14px 0 6px; font-weight: 600; }
.coordinate-origin-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 16px; }
.coordinate-fields { display: grid; gap: 2px; }
.coordinate-wgs84 { display: grid; gap: 11px; padding: 8px 0; font-size: 13px; }
.coordinate-wgs84 span:first-child { font-weight: 600; }
.coordinate-warning { color: #ffbd80; }
.model-input strong { color: #ff9b91; }
button, select, input { margin: 5px; padding: 7px; color: #edf5ff; background: #122238; border: 1px solid #385574; border-radius: 6px; }
button { cursor: pointer; transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease, transform .16s ease; } button:disabled { opacity: .5; cursor: default; }
@media (hover: hover) { .merge-page button:not(:disabled):hover { border-color: #65d9b4; background-color: #1b3a4b; box-shadow: 0 0 0 1px #65d9b43d, 0 3px 10px #0004; transform: translateY(-1px); } }
.scene canvas { display: block; max-width: 100%; height: auto; margin: auto; cursor: crosshair; border: 1px solid #385574; }
@media (max-width: 950px) { .model-input-content { grid-template-columns: 1fr; } }
@media (max-width: 1050px) { .coordinate-origin-grid { grid-template-columns: 1fr; } }
</style>
