<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiFetch } from '../../api/api-auth';
import { createEditorTask, decimateEditorTask, editorDownloadUrl, editorExportUrl, editorManifestUrl,
  exportEditorResult, jumpEditorHistory,
  listEditorTasks, loadEditorTask, processEditorTask, queryEditorCoordinates, recordEditorEdit,
  type EditorDisplayClip, type EditorGeography, type EditorInputKind, type EditorRule, type EditorState, type EditorTask,
  type EditorTransform } from '../../api/gaussian-editor-api';
import ModuleTopbar from '../../components/ModuleTopbar.vue';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { formatTaskTime } from '../../shared/task-time';
import { pickDirectory } from '../../shared/directory-selection';
import type { XYZ } from '../../coordinate-math';
import EditorViewport from './EditorViewport.vue';
import '../../styles/module-entry.css';

const route = useRoute();
const router = useRouter();
const workspace = useWorkspaceStore();
const task = ref<EditorTask | null>(null);
const history = ref<EditorTask[]>([]);
const kind = ref<EditorInputKind>('single');
const files = ref<File[]>([]);
const paths = ref<string[]>([]);
const datasetDirectory = ref(false);
const fallbackDirectoryInput = ref<HTMLInputElement>();
const busy = ref(false);
const phase = ref('');
const uploaded = ref(0);
const uploadTotal = ref(0);
const downloadProgress = ref<{ loaded: number; total: number | null } | null>(null);
const submittingTask = ref<'process' | 'decimate' | 'export' | null>(null);
const submittingExport = ref<string | null>(null);
const taskOperationBusy = computed(() => !!submittingTask.value || [task.value?.process_status,
  task.value?.decimate_status, task.value?.export_status].some(status => status === 'queued' || status === 'running'));
const message = ref('');
const panel = ref<'lod' | 'bounds' | 'slice' | 'coordinates' | 'transform' | 'history' | 'results' | null>('lod');
const identityTransform = (): EditorTransform => ({ translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] });
const transformDraft = ref<EditorTransform>(identityTransform());
const geographyDraft = ref<EditorGeography>({ reference: [0, 0, 0], projected_origin: [0, 0, 0],
  axes: [1, 2, 3], metres_per_unit: 1, source_epsg: 0 });
const coordinateResult = ref<{ independent: XYZ; projected: XYZ; longitude: number; latitude: number; height_note: string } | null>(null);
const coordinateBusy = ref(false);
let geographyTaskId = '';
function copyGeography(frame: EditorGeography): EditorGeography {
  return { ...frame, reference: [...frame.reference], projected_origin: [...frame.projected_origin], axes: [...frame.axes] };
}
function initialGeography(source: EditorTask): EditorGeography {
  return { reference: [0, 0, 0],
    projected_origin: source.coordinate_metadata?.offset.map(value => Number(value ?? 0)) as XYZ ?? [0, 0, 0],
    axes: source.coordinate_metadata?.axes ?? [1, 2, 3], metres_per_unit: 1,
    source_epsg: Number(source.coordinate_metadata?.epsg ?? 0) };
}
const defaultClip = (): EditorDisplayClip => ({
    mode: 'off', min: [-1e30, -1e30, -1e30], max: [1e30, 1e30, 1e30],
    center: [0, 0, 0], size: [1, 1, 1],
    planes: { xoy: { visible: false, side: 1 }, xoz: { visible: false, side: 1 }, yoz: { visible: false, side: 1 } },
  });
const clip = ref<EditorDisplayClip>(defaultClip());
function copyClip(value: EditorDisplayClip): EditorDisplayClip {
  return { mode: value.mode, min: [...value.min], max: [...value.max], center: [...value.center], size: [...value.size],
    planes: { xoy: { ...value.planes.xoy }, xoz: { ...value.planes.xoz }, yoz: { ...value.planes.yoz } } };
}
const clipThickness = ref(1);
const workLevel = ref(0);
const lastPoint = ref<XYZ | null>(null);
const polygonDraft = ref<[number, number][]>([]);
const drawingPolygon = ref(false);
const editingPolygon = ref<number | null>(null);
const editingVolume = ref<number | null>(null);
const volumeDraft = ref<Extract<EditorRule, { type: 'sphere' | 'box' }> | null>(null);
function copyVolume(rule: Extract<EditorRule, { type: 'sphere' | 'box' }>): typeof rule {
  return rule.type === 'sphere' ? { ...rule, center: [...rule.center] }
    : { ...rule, center: [...rule.center], size: [...rule.size], rotation: [...rule.rotation] };
}
const boundaryAction = ref<'keep' | 'remove'>('keep');
const sphereRadius = ref(1);
const boxSize = ref<XYZ>([1, 1, 1]);
const boxRotation = ref<XYZ>([0, 0, 0]);
const targetCount = ref(100_000);
const decimationMode = ref<'count' | 'ratio'>('count');
const retainPercent = ref(10);
let timer: ReturnType<typeof setInterval> | null = null;
let jumpingHistory = false;

const currentState = computed<EditorState>(() => task.value?.history[task.value.history_cursor]?.state
  ?? { rules: [], selected_lods: [] });
const displayRules = computed(() => currentState.value.rules.map((rule, index) => {
  if (index === editingPolygon.value && rule.type === 'polygon' && polygonDraft.value.length >= 3)
    return { type: 'polygon', action: boundaryAction.value, points: polygonDraft.value } as EditorRule;
  return index === editingVolume.value && volumeDraft.value ? volumeDraft.value : rule;
}));
watch([() => task.value?.task_id, () => JSON.stringify(currentState.value.display_clip ?? null)], () => {
  clip.value = currentState.value.display_clip ? copyClip(currentState.value.display_clip) : defaultClip();
}, { immediate: true });
const currentTransform = computed(() => currentState.value.transform ?? identityTransform());
const previewLevel = computed(() => task.value?.input_kind === 'single' ? 0 : task.value?.available_levels.at(-1) ?? 0);
const selectedLod = computed(() => task.value?.lods.find(item => item.level === workLevel.value));
const sourceLevelCount = computed(() => selectedLod.value?.count ?? task.value?.level_counts?.[workLevel.value]
  ?? (task.value?.input_kind === 'single' ? task.value.metadata?.source_point_count : undefined));
const ratioTargetCount = computed(() => sourceLevelCount.value && Number.isFinite(retainPercent.value)
  ? Math.round(sourceLevelCount.value * retainPercent.value / 100) : 0);
const selectedDerived = computed(() => task.value?.derived_lods.find(item => item.source_level === workLevel.value
  && item.version === currentState.value.decimation?.version));
const useDerived = computed(() => !!selectedDerived.value);
watch([() => task.value?.task_id, () => currentState.value.decimation?.version], () => {
  const selection = currentState.value.decimation;
  targetCount.value = selection?.target_count ?? 100_000;
  decimationMode.value = selection?.retain_percent != null ? 'ratio' : 'count';
  retainPercent.value = selection?.retain_percent ?? 10;
  if (task.value) workLevel.value = selection?.level ?? (task.value.input_kind === 'dataset'
    ? task.value.available_levels.at(-1) ?? 0 : task.value.available_levels[0] ?? 0);
}, { immediate: true });
const currentUrl = computed(() => useDerived.value && selectedDerived.value ? selectedDerived.value.gaussian_url : selectedLod.value?.gaussian_url ??
  (task.value?.format === 'lcc' || task.value?.format === 'lcc2' || task.value?.format === 'streamed_sog'
    || workLevel.value === 0 ? task.value?.gaussian_url : undefined));
const currentFilename = computed(() => useDerived.value && selectedDerived.value ? 'work-lod.ply' :
  selectedLod.value?.name ?? task.value?.gaussian_filename ?? task.value?.filename ?? 'model.ply');
const largeOriginalBytes = computed(() => {
  if (useDerived.value || !task.value || task.value.input_kind === 'dataset') return 0;
  const bytes = selectedLod.value?.bytes ?? task.value.source_bytes ?? 0;
  return bytes > 256 * 1024 * 1024 ? bytes : 0;
});
const levelCount = computed(() => useDerived.value && selectedDerived.value ? selectedDerived.value.count :
  selectedLod.value?.count ?? task.value?.level_counts?.[workLevel.value] ?? (selectedLod.value?.level === (task.value?.lods.length ?? 0) - 1
  || (task.value?.available_levels.length === 1 && workLevel.value === 0)
  ? task.value?.metadata?.source_point_count : undefined));
const largeOriginalCount = computed(() => !useDerived.value && task.value?.input_kind === 'dataset'
  && (levelCount.value ?? 0) > 20_000_000 ? levelCount.value : 0);

async function refresh(): Promise<void> {
  const id = route.params.taskId;
  try {
    if (typeof id === 'string') {
      const loaded = await loadEditorTask(id);
      task.value = loaded;
      if (geographyTaskId !== id) {
        geographyTaskId = id;
        workLevel.value = loaded.input_kind === 'dataset' ? loaded.available_levels.at(-1) ?? 0 : loaded.available_levels[0] ?? 0;
        editingVolume.value = null;
        volumeDraft.value = null;
        geographyDraft.value = copyGeography(loaded.history[loaded.history_cursor]?.state.geography
          ?? initialGeography(loaded));
        coordinateResult.value = null;
        transformDraft.value = structuredClone(loaded.history[loaded.history_cursor]?.state.transform ?? identityTransform());
      }
      if (!loaded.available_levels.includes(workLevel.value) && loaded.available_levels.length) {
        workLevel.value = loaded.available_levels.at(-1)!;
      }
    } else {
      task.value = null;
      history.value = await listEditorTasks(workspace.workspaceId);
    }
  } catch (error) { message.value = error instanceof Error ? error.message : String(error); }
}
watch(() => route.params.taskId, () => { void refresh(); }, { immediate: true });
timer = setInterval(() => { if (route.params.taskId) void refresh(); }, 1500);
onMounted(() => window.addEventListener('keydown', historyShortcut));
onUnmounted(() => { if (timer) clearInterval(timer); window.removeEventListener('keydown', historyShortcut); });

function selectFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  files.value = Array.from(input.files ?? []);
  paths.value = files.value.map(file => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
  datasetDirectory.value = files.value.some(file => Boolean((file as File & { webkitRelativePath?: string }).webkitRelativePath));
}
async function selectDirectory(): Promise<void> {
  try {
    const selection = await pickDirectory(() => fallbackDirectoryInput.value?.click());
    if (!selection) return;
    files.value = selection.files;
    paths.value = selection.paths;
    datasetDirectory.value = true;
    message.value = selection.files.length ? '' : '所选目录中没有文件';
  } catch (error) { message.value = error instanceof Error ? error.message : String(error); }
}
async function create(): Promise<void> {
  if (!files.value.length || busy.value) return;
  busy.value = true; message.value = ''; phase.value = '上传中'; uploaded.value = 0; uploadTotal.value = 0;
  try {
    const created = await createEditorTask({ kind: kind.value, workspaceId: workspace.workspaceId,
      file: kind.value === 'lod_group' || datasetDirectory.value ? undefined : files.value[0],
      files: kind.value === 'lod_group' || datasetDirectory.value ? files.value : undefined,
      paths: paths.value,
      onProgress: (loaded, total) => { uploaded.value = loaded; uploadTotal.value = total; },
    });
    phase.value = '服务端预读与生成场景预览';
    await router.push(`/editor/${created.task_id}`);
  } catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { busy.value = false; }
}
async function saveEdit(label: string, state: EditorState): Promise<boolean> {
  if (!task.value) return false;
  try { task.value = await recordEditorEdit(task.value.task_id, label, state); message.value = ''; return true; }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); return false; }
}
function addRule(rule: EditorRule, label: string): void {
  void saveEdit(label, { ...currentState.value, rules: [...currentState.value.rules, rule] });
}
async function addPolygon(): Promise<void> {
  if (polygonDraft.value.length < 3) { message.value = '平面边界至少需要三个取点'; return; }
  const rule: EditorRule = { type: 'polygon', action: boundaryAction.value,
    points: polygonDraft.value.map(point => [...point]) };
  const saved = await saveEdit(editingPolygon.value === null ? '新增平面边界' : '修改平面边界',
    { ...currentState.value, rules: editingPolygon.value === null ? [...currentState.value.rules, rule]
      : currentState.value.rules.map((item, index) => index === editingPolygon.value ? rule : item) });
  if (!saved) return;
  polygonDraft.value = [];
  drawingPolygon.value = false;
  editingPolygon.value = null;
}
function editPolygon(index: number): void {
  const rule = currentState.value.rules[index];
  if (rule.type !== 'polygon') return;
  editingPolygon.value = index;
  drawingPolygon.value = false;
  boundaryAction.value = rule.action;
  polygonDraft.value = rule.points.map(point => [...point]);
}
function editVolume(index: number): void {
  const rule = currentState.value.rules[index];
  if (rule.type === 'polygon') return;
  editingVolume.value = index;
  volumeDraft.value = copyVolume(rule);
}
function moveVolumeCenter(point: [number, number]): void {
  if (!volumeDraft.value) return;
  volumeDraft.value.center[0] = point[0];
  volumeDraft.value.center[1] = point[1];
}
function moveVolumeHeight(height: number): void {
  if (volumeDraft.value) volumeDraft.value.center[2] = height;
}
function moveVolumeRadius(radius: number): void {
  if (volumeDraft.value?.type === 'sphere') volumeDraft.value.radius = radius;
}
function moveBoxSize(axis: number, size: number): void {
  if (volumeDraft.value?.type === 'box') volumeDraft.value.size[axis] = size;
}
function rotateBox(rotation: [number, number, number, number]): void {
  if (volumeDraft.value?.type === 'box') volumeDraft.value.rotation = rotation;
}
async function saveVolume(): Promise<void> {
  if (editingVolume.value === null || !volumeDraft.value) return;
  const rule = copyVolume(volumeDraft.value);
  if (!rule.center.every(Number.isFinite) || (rule.type === 'sphere'
    ? !Number.isFinite(rule.radius) || rule.radius <= 0
    : !rule.size.every(value => Number.isFinite(value) && value > 0)
      || !rule.rotation.every(Number.isFinite) || Math.hypot(...rule.rotation) < 1e-8)) {
    message.value = '请输入有效的边界中心、尺寸及旋转参数'; return;
  }
  if (rule.type === 'box') {
    const length = Math.hypot(...rule.rotation);
    rule.rotation = rule.rotation.map(value => value / length) as [number, number, number, number];
  }
  const index = editingVolume.value;
  if (await saveEdit(`修改${rule.type === 'sphere' ? '球形' : '长方体'}边界`, {
    ...currentState.value, rules: currentState.value.rules.map((item, ruleIndex) => ruleIndex === index ? rule : item),
  })) { editingVolume.value = null; volumeDraft.value = null; }
}
function addSphere(): void {
  if (!lastPoint.value) { message.value = '先在场景中取一个球心'; return; }
  addRule({ type: 'sphere', action: boundaryAction.value, center: [...lastPoint.value], radius: sphereRadius.value }, '新增球形边界');
}
function addBox(): void {
  if (!lastPoint.value) { message.value = '先在场景中取一个中心点'; return; }
  const [x, y, z] = boxRotation.value.map(angle => angle * Math.PI / 360);
  const [cx, cy, cz] = [Math.cos(x), Math.cos(y), Math.cos(z)];
  const [sx, sy, sz] = [Math.sin(x), Math.sin(y), Math.sin(z)];
  const rotation: [number, number, number, number] = [
    cx * cy * cz + sx * sy * sz, sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz,
  ];
  addRule({ type: 'box', action: boundaryAction.value, center: [...lastPoint.value], size: [...boxSize.value],
    rotation }, '新增长方体边界');
}
function removeRule(index: number): void {
  editingVolume.value = null; volumeDraft.value = null;
  void saveEdit('移除边界', { ...currentState.value, rules: currentState.value.rules.filter((_, i) => i !== index) });
}
function picked(point: XYZ): void {
  lastPoint.value = point;
  coordinateResult.value = null;
}
function movePolygonVertex(index: number, point: [number, number]): void {
  polygonDraft.value[index] = point;
}
function insertPolygonVertex(index: number, point: [number, number]): void {
  polygonDraft.value.splice(index, 0, point);
}
async function saveGeography(): Promise<void> {
  const frame = copyGeography(geographyDraft.value);
  if (!Number.isInteger(frame.source_epsg) || frame.source_epsg <= 0
    || frame.metres_per_unit <= 0 || ![...frame.reference, ...frame.projected_origin].every(Number.isFinite)) {
    message.value = '请输入有效 EPSG、参考坐标、投影原点和单位'; return;
  }
  await saveEdit('修改坐标原点', { ...currentState.value, geography: frame });
}
async function saveTransform(): Promise<void> {
  const translation = [...transformDraft.value.translation] as XYZ;
  const rotation_degrees = [...transformDraft.value.rotation_degrees] as XYZ;
  const scale = transformDraft.value.scale[0];
  if (![...translation, ...rotation_degrees, scale].every(Number.isFinite) || scale <= 0) {
    message.value = '请输入有效的平移、旋转和正数缩放'; return;
  }
  await saveEdit('修改模型整体变换', { ...currentState.value,
    transform: { translation, rotation_degrees, scale: [scale, scale, scale] } });
}
async function queryCoordinates(): Promise<void> {
  if (!task.value || !lastPoint.value || !currentState.value.geography) {
    message.value = '请先保存坐标设置并在场景中取点'; return;
  }
  coordinateBusy.value = true; coordinateResult.value = null;
  try { coordinateResult.value = await queryEditorCoordinates(task.value.task_id, lastPoint.value, currentState.value.geography); }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { coordinateBusy.value = false; }
}
function slice(plane: 'xoy' | 'xoz' | 'yoz'): void {
  const bounds = task.value?.metadata?.bounds;
  if (!bounds || !Number.isFinite(clipThickness.value) || clipThickness.value <= 0) return;
  const axis = { xoy: 2, xoz: 1, yoz: 0 }[plane];
  clip.value.min = [...bounds.min]; clip.value.max = [...bounds.max];
  const middle = (bounds.min[axis] + bounds.max[axis]) / 2;
  clip.value.min[axis] = middle - clipThickness.value / 2;
  clip.value.max[axis] = middle + clipThickness.value / 2;
  clip.value.mode = 'axis';
  void saveDisplayClip(`设置 ${plane.toUpperCase()} 显示剖切`);
}
async function saveDisplayClip(label = '修改显示剖切'): Promise<void> {
  const value = copyClip(clip.value);
  if (![...value.min, ...value.max, ...value.center, ...value.size].every(Number.isFinite)
    || value.min.some((minimum, axis) => minimum > value.max[axis])
    || value.size.some(size => size <= 0)) { message.value = '请输入有效的剖切范围和矩形框尺寸'; return; }
  await saveEdit(label, { ...currentState.value, display_clip: value });
}
async function jump(index: number): Promise<void> {
  if (!task.value || jumpingHistory || index < 0 || index >= task.value.history.length) return;
  jumpingHistory = true;
  try { task.value = await jumpEditorHistory(task.value.task_id, index);
    polygonDraft.value = []; editingPolygon.value = null; drawingPolygon.value = false;
    editingVolume.value = null; volumeDraft.value = null;
    geographyDraft.value = copyGeography(task.value.history[index].state.geography ?? initialGeography(task.value));
    const selectedTransform = task.value.history[index]?.state.transform ?? identityTransform();
    transformDraft.value = { translation: [...selectedTransform.translation],
      rotation_degrees: [...selectedTransform.rotation_degrees], scale: [...selectedTransform.scale] };
    coordinateResult.value = null;
  }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { jumpingHistory = false; }
}
function historyShortcut(event: KeyboardEvent): void {
  if (!task.value || !(event.ctrlKey || event.metaKey) || event.altKey || event.repeat) return;
  const target = event.target;
  if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) return;
  const key = event.key.toLowerCase();
  const redo = key === 'y' || (key === 'z' && event.shiftKey);
  if (key !== 'z' && key !== 'y' || key === 'y' && event.shiftKey) return;
  event.preventDefault();
  const next = task.value.history_cursor + (redo ? 1 : -1);
  if (next >= 0 && next < task.value.history.length) void jump(next);
}
function toggleLevel(level: number, checked: boolean): void {
  const levels = checked ? [...currentState.value.selected_lods, level] : currentState.value.selected_lods.filter(item => item !== level);
  void saveEdit('修改目标层级', { ...currentState.value, selected_lods: [...new Set(levels)].sort((a, b) => a - b) });
}
async function run(): Promise<void> {
  if (!task.value || !currentState.value.selected_lods.length || taskOperationBusy.value) return;
  submittingTask.value = 'process';
  try { task.value = await processEditorTask(task.value.task_id, currentState.value.selected_lods); panel.value = 'results'; }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { submittingTask.value = null; }
}
async function decimate(): Promise<void> {
  if (!task.value || taskOperationBusy.value) return;
  const ratio = decimationMode.value === 'ratio' ? retainPercent.value : undefined;
  const count = ratio === undefined ? targetCount.value : ratioTargetCount.value;
  if (ratio !== undefined && (!sourceLevelCount.value || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 100)) {
    message.value = '当前层级点数未知或保留比例无效'; return;
  }
  if (!Number.isSafeInteger(count) || count <= 0 || sourceLevelCount.value && count >= sourceLevelCount.value) {
    message.value = '请输入有效的抽稀目标高斯数'; return;
  }
  submittingTask.value = 'decimate';
  try { task.value = await decimateEditorTask(task.value.task_id, workLevel.value, count, ratio); panel.value = 'lod'; }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { submittingTask.value = null; }
}
async function selectDerived(item: EditorTask['derived_lods'][number] | null): Promise<void> {
  if (!task.value) return;
  await saveEdit(item ? '选择抽稀工作层' : '使用原始工作层', { ...currentState.value,
    decimation: item ? { version: item.version, level: item.source_level,
      target_count: item.target_count, retain_percent: item.retain_percent } : null });
}
async function convertExport(version: string, level: number, format: 'compressed_ply' | 'sog'): Promise<void> {
  if (!task.value || taskOperationBusy.value) return;
  submittingTask.value = 'export';
  submittingExport.value = `${version}:${level}:${format}`;
  try { task.value = await exportEditorResult(task.value.task_id, version, level, format); panel.value = 'results'; }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { submittingTask.value = null; submittingExport.value = null; }
}
async function download(version: string, level: number, format: 'ply' | 'compressed_ply' | 'sog' = 'ply'): Promise<void> {
  if (!task.value) return;
  type WritableResult = { write(value: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
  const picker = (window as typeof window & { showSaveFilePicker?: (options: { suggestedName: string }) =>
    Promise<{ createWritable(): Promise<WritableResult> }> }).showSaveFilePicker;
  if (!picker) { message.value = '当前浏览器不支持大文件流式保存，请使用 Chrome 或 Edge'; return; }
  let writable: WritableResult | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const suffix = format === 'compressed_ply' ? 'compressed.ply' : format;
    const handle = await picker({ suggestedName: `lod-${level}-edited.${suffix}` });
    const response = await apiFetch(format === 'ply' ? editorDownloadUrl(task.value.task_id, version, level)
      : editorExportUrl(task.value.task_id, version, level, format));
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('Content-Length'));
    downloadProgress.value = { loaded: 0, total: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null };
    writable = await handle.createWritable();
    reader = response.body.getReader();
    while (true) { const { value, done } = await reader.read(); if (done) break; await writable.write(value);
      downloadProgress.value.loaded += value.byteLength; }
    await writable.close(); writable = null; message.value = '成果下载完成';
  } catch (error) {
    await Promise.allSettled([reader?.cancel(), writable?.abort()]);
    message.value = error instanceof Error ? error.message : String(error);
  }
  finally { downloadProgress.value = null; }
}
async function downloadManifest(version: string, level: number, format: 'ply' | 'compressed_ply' | 'sog'): Promise<void> {
  if (!task.value) return;
  try {
    const response = await apiFetch(editorManifestUrl(task.value.task_id, version, level, format));
    if (!response.ok) throw new Error(`坐标说明下载失败：HTTP ${response.status}`);
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `lod-${level}-edited-${format}-manifest.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) { message.value = error instanceof Error ? error.message : String(error); }
}
</script>

<template>
  <main class="editor-page" :class="{ 'editor-workspace': task }">
    <ModuleTopbar title="高斯编辑" mark="E"><template #actions><RouterLink to="/editor">新建任务</RouterLink></template></ModuleTopbar>
    <template v-if="!task">
      <div class="module-entry-content module-entry-single">
        <div class="module-entry-intro"><h1>创建高斯编辑任务</h1><p>导入单个高斯模型或同一模型的 LOD 文件组；大层级可先抽稀后编辑。</p></div>
        <section class="module-entry-card"><h2>新建任务</h2>
          <div class="module-entry-tile editor-upload">
            <label>输入方式<select v-model="kind" @change="files = []; paths = []; datasetDirectory = false"><option value="single">单个高斯文件</option><option value="lod_group">有序 LOD 文件组</option><option value="dataset">完整数据集 ZIP／目录</option></select></label>
            <input v-if="kind === 'single'" type="file" accept=".ply,.sog,.spz" @change="selectFiles">
            <input v-else-if="kind === 'lod_group'" type="file" accept=".ply" multiple @change="selectFiles">
            <template v-else><label>ZIP 文件<input type="file" accept=".zip" @change="selectFiles"></label><button type="button" @click="selectDirectory">选择数据集目录</button><input ref="fallbackDirectoryInput" hidden type="file" webkitdirectory multiple @change="selectFiles"></template>
            <p v-if="kind === 'lod_group'">按精细到粗略顺序选择 LOD；输入文件须属于同一模型。</p>
            <p v-if="files.length">已选择 {{ files.length }} 个文件</p>
          </div>
          <button type="button" :disabled="busy || !files.length" @click="create">{{ busy ? '正在创建任务…' : '上传并创建任务' }}</button>
          <p v-if="busy" role="status">{{ phase }}<template v-if="uploadTotal">：{{ Math.round(uploaded * 100 / uploadTotal) }}%</template></p>
          <progress v-if="busy && uploadTotal" :value="uploaded" :max="uploadTotal"></progress>
        </section>
        <section class="module-entry-card"><h2>历史任务</h2><p v-if="!history.length">暂无任务</p>
          <ul class="module-entry-history-list"><li v-for="item in history" :key="item.task_id"><RouterLink :to="`/editor/${item.task_id}`">{{ item.filename }}</RouterLink>
            <small>创建：{{ formatTaskTime(item.created_at_unix) }} · 最近更新：{{ formatTaskTime(item.updated_at_unix) }}</small></li></ul>
        </section>
      </div>
    </template>
    <div v-else class="editor-stage">
      <EditorViewport v-if="task.status === 'ready' && task.preview_url && task.metadata" :preview-url="task.preview_url"
        :gaussian-url="currentUrl" :filename="currentFilename" :gaussian-lod="task.available_levels.length > 1 && !selectedLod && !useDerived ? workLevel : undefined" :origin="task.metadata.origin"
        :point-count="levelCount" :lod-label="`LOD ${workLevel}`" :preview-lod-label="`LOD ${previewLevel}`"
        :preview-point-count="task.metadata.source_point_count" :clip="clip" :transform="currentTransform"
        :rules="displayRules" :polygon-draft="polygonDraft" :editing-polygon-index="editingPolygon"
        :snapping-polygon="panel === 'bounds'" :drawing-polygon="panel === 'bounds' && drawingPolygon"
        :editing-volume-index="editingVolume" @pick-polygon="polygonDraft.push($event)"
        :large-original-bytes="largeOriginalBytes" :large-original-count="largeOriginalCount" @pick="picked"
        @move-vertex="movePolygonVertex" @insert-vertex="insertPolygonVertex"
        @move-volume-center="moveVolumeCenter" @move-volume-height="moveVolumeHeight"
        @move-volume-radius="moveVolumeRadius"
        @move-box-size="moveBoxSize" @rotate-box="rotateBox" @notify="message = $event">
        <template #tools>
          <button type="button" @click="panel = panel === 'lod' ? null : 'lod'">层级／抽稀</button>
          <button type="button" @click="panel = panel === 'bounds' ? null : 'bounds'">边界</button>
          <button type="button" @click="panel = panel === 'slice' ? null : 'slice'">剖切</button>
          <button type="button" @click="panel = panel === 'coordinates' ? null : 'coordinates'">坐标</button>
          <button type="button" @click="panel = panel === 'transform' ? null : 'transform'">模型变换</button>
          <button type="button" :disabled="task.history_cursor === 0" @click="jump(task.history_cursor - 1)">撤销</button>
          <button type="button" :disabled="task.history_cursor >= task.history.length - 1" @click="jump(task.history_cursor + 1)">重做</button>
          <button type="button" @click="panel = panel === 'history' ? null : 'history'">历史操作</button>
          <button type="button" @click="panel = panel === 'results' ? null : 'results'">成果</button>
        </template>
      </EditorViewport>
      <div v-else class="editor-wait" role="status">{{ task.status === 'failed' ? task.error : '正在预读模型并生成轻量场景预览…' }}</div>
      <aside v-if="panel" class="editor-panel" :class="`editor-panel-${panel}`">
        <header><h2>{{ { lod: '层级与抽稀', bounds: '裁剪边界', slice: '显示剖切', coordinates: '坐标与原点', transform: '模型整体变换', history: '历史操作', results: '处理成果' }[panel] }}</h2><button type="button" @click="panel = null" aria-label="关闭面板">×</button></header>
        <template v-if="panel === 'lod'">
          <label>工作 LOD<select v-model.number="workLevel"><option v-for="level in task.available_levels" :key="level" :value="level">LOD {{ level }}</option></select></label>
          <p>点云预览来自 LOD {{ previewLevel }}；显示高斯时加载选定工作层，其他目标层在执行时由服务端处理。</p>
          <p v-if="largeOriginalBytes">原始层 {{ (largeOriginalBytes / 1048576).toFixed(1) }} MiB，当前仅显示点云预览；请选择较低 LOD 或先抽稀，再加载高斯编辑。</p>
          <p v-if="largeOriginalCount">当前原始层约 {{ largeOriginalCount.toLocaleString() }} 个高斯，当前仅显示点云预览；请选择较低 LOD 或先抽稀，再加载高斯编辑。</p>
          <label>抽稀方式<select v-model="decimationMode"><option value="count">目标高斯数</option><option value="ratio" :disabled="!sourceLevelCount">保留比例</option></select></label>
          <label v-if="decimationMode === 'count'">抽稀目标高斯数<input v-model.number="targetCount" type="number" min="1" step="1"></label>
          <template v-else><label>保留比例（％）<input v-model.number="retainPercent" type="number" min="0" max="100" step="any"></label>
            <p>原始层 {{ sourceLevelCount?.toLocaleString() ?? '数量未知' }} 高斯，预计保留 {{ ratioTargetCount.toLocaleString() }} 高斯。</p></template>
          <button type="button" :disabled="taskOperationBusy || task.status !== 'ready'" @click="decimate">{{ submittingTask === 'decimate' ? '正在提交抽稀…' : '生成轻量工作层' }}</button>
          <p v-if="task.decimate_status !== 'not_requested'" role="status">抽稀：{{ task.decimate_phase ?? task.decimate_status }}<template v-if="task.decimate_progress !== null && task.decimate_progress !== undefined"> {{ task.decimate_progress }}%</template> {{ task.decimate_error }}</p>
          <p v-for="item in task.derived_lods" :key="item.version">派生自 LOD {{ item.source_level }}：{{ item.count.toLocaleString() }} 高斯
            <button v-if="item.source_level === workLevel" type="button" :disabled="selectedDerived?.version === item.version"
              @click="selectDerived(item)">{{ selectedDerived?.version === item.version ? '当前工作层' : '用作工作层' }}</button></p>
          <p v-if="useDerived">当前选用派生工作层；正式处理仍从所选原始 LOD 读取。
            <button type="button" @click="selectDerived(null)">使用原始工作层</button></p>
          <h3>应用规则到</h3><label v-for="level in task.available_levels" :key="level"><input type="checkbox" :checked="currentState.selected_lods.includes(level)" @change="toggleLevel(level, ($event.target as HTMLInputElement).checked)">LOD {{ level }}</label>
          <button type="button" :disabled="taskOperationBusy || !currentState.selected_lods.length" @click="run">{{ submittingTask === 'process' ? '正在提交处理…' : '处理选中层级' }}</button>
        </template>
        <template v-else-if="panel === 'bounds'">
          <p>点击「开始 2D 绘制」后逐点点击场景平面，空白区域也可取点；平面边界沿模型全高生效。「场景取点」用于球心或坐标查询。</p>
          <p v-if="lastPoint">当前取点：{{ lastPoint.map(value => value.toFixed(3)).join('，') }}</p>
          <label>边界规则<select v-model="boundaryAction"><option value="keep">保留内部</option><option value="remove">剔除内部</option></select></label>
          <button type="button" @click="drawingPolygon = !drawingPolygon">{{ drawingPolygon ? '结束 2D 绘制' : '开始 2D 绘制' }}</button>
          <p>{{ editingPolygon === null ? '平面草稿' : '正在编辑平面边界' }}：{{ polygonDraft.length }} 点</p>
          <div v-for="(point, index) in polygonDraft" :key="index" class="editor-clip-row editor-vertex-row"><span>{{ index + 1 }}</span><input v-model.number="point[0]" type="number" step="any" :aria-label="`顶点 ${index + 1} X`"><input v-model.number="point[1]" type="number" step="any" :aria-label="`顶点 ${index + 1} Y`"><button type="button" @click="polygonDraft.splice(index, 1)">删点</button></div>
          <button type="button" :disabled="polygonDraft.length < 3" @click="addPolygon">{{ editingPolygon === null ? '完成 2D 平面边界' : '保存平面边界' }}</button>
          <button type="button" :disabled="!polygonDraft.length" @click="polygonDraft = []; editingPolygon = null; drawingPolygon = false">清空草稿</button>
          <label>球半径<input v-model.number="sphereRadius" type="number" min="0.001" step="any"></label>
          <button type="button" :disabled="!lastPoint || sphereRadius <= 0" @click="addSphere">以取点为球心添加球体</button>
          <div class="editor-size"><label v-for="(_, axis) in boxSize" :key="axis">{{ ['X','Y','Z'][axis] }} 尺寸<input v-model.number="boxSize[axis]" type="number" min="0.001" step="any"></label></div>
          <div class="editor-size"><label v-for="(_, axis) in boxRotation" :key="axis">{{ ['X','Y','Z'][axis] }} 旋转角度<input v-model.number="boxRotation[axis]" type="number" step="any"></label></div>
          <button type="button" :disabled="!lastPoint || boxSize.some(value => value <= 0)" @click="addBox">以取点为中心添加长方体</button>
          <h3>已有边界</h3><p v-if="!currentState.rules.length">暂无边界</p>
          <div v-for="(rule, index) in currentState.rules" :key="index" class="editor-rule"><span>{{ index + 1 }}．{{ { polygon: '平面', sphere: '球体', box: '长方体' }[rule.type] }} · {{ rule.action === 'keep' ? '保留内部' : '剔除内部' }}</span><button v-if="rule.type === 'polygon'" type="button" @click="editPolygon(index)">编辑顶点</button><button v-else type="button" @click="editVolume(index)">编辑体积</button><button type="button" @click="removeRule(index)">移除</button></div>
          <template v-if="volumeDraft">
            <h3>编辑{{ volumeDraft.type === 'sphere' ? '球形' : '长方体' }}边界</h3>
            <p>拖动青色手柄调整中心 X／Y、紫色手柄调整中心 Z；{{ volumeDraft.type === 'sphere' ? '拖动黄色手柄调整半径；' : '拖动实心手柄调整三轴尺寸，空心手柄绕对应局部轴旋转；' }}保存后写入一条历史记录。</p>
            <label>范围规则<select v-model="volumeDraft.action"><option value="keep">保留内部</option><option value="remove">剔除内部</option></select></label>
            <div class="editor-size"><label v-for="(_, axis) in volumeDraft.center" :key="axis">中心 {{ ['X','Y','Z'][axis] }}<input v-model.number="volumeDraft.center[axis]" type="number" step="any"></label></div>
            <label v-if="volumeDraft.type === 'sphere'">球半径<input v-model.number="volumeDraft.radius" type="number" min="0.001" step="any"></label>
            <template v-else>
              <div class="editor-size"><label v-for="(_, axis) in volumeDraft.size" :key="axis">{{ ['X','Y','Z'][axis] }} 尺寸<input v-model.number="volumeDraft.size[axis]" type="number" min="0.001" step="any"></label></div>
              <p>旋转四元数按 W／X／Y／Z 输入，保存时归一化。</p>
              <div class="editor-size editor-quaternion"><label v-for="(_, axis) in volumeDraft.rotation" :key="axis">{{ ['W','X','Y','Z'][axis] }}<input v-model.number="volumeDraft.rotation[axis]" type="number" step="any"></label></div>
            </template>
            <button type="button" @click="saveVolume">保存体积边界</button>
            <button type="button" @click="editingVolume = null; volumeDraft = null">取消编辑</button>
          </template>
        </template>
        <template v-else-if="panel === 'slice'">
          <p>剖切仅改变场景显示；裁剪导出请使用「边界」规则。</p>
          <label>切片厚度<input v-model.number="clipThickness" type="number" min="0.001" step="any"></label>
          <div><button v-for="plane in ['xoy', 'xoz', 'yoz'] as const" :key="plane" type="button" @click="slice(plane)">{{ plane.toUpperCase() }}</button></div>
          <label>剖切方式<select v-model="clip.mode"><option value="off">关闭</option><option value="axis">三轴范围</option><option value="box">矩形框</option></select></label>
          <template v-if="clip.mode === 'axis'"><div v-for="(_, axis) in clip.min" :key="axis" class="editor-clip-row"><span>{{ ['X','Y','Z'][axis] }}</span><input v-model.number="clip.min[axis]" type="number" step="any" :aria-label="`${['X','Y','Z'][axis]} 最小值`"><input v-model.number="clip.max[axis]" type="number" step="any" :aria-label="`${['X','Y','Z'][axis]} 最大值`"></div></template>
          <template v-if="clip.mode === 'box'"><div v-for="(_, axis) in clip.center" :key="axis" class="editor-clip-row"><span>{{ ['X','Y','Z'][axis] }}</span><input v-model.number="clip.center[axis]" type="number" step="any" :aria-label="`${['X','Y','Z'][axis]} 中心`"><input v-model.number="clip.size[axis]" type="number" min="0.001" step="any" :aria-label="`${['X','Y','Z'][axis]} 尺寸`"></div></template>
          <h3>原点平面</h3><label v-for="plane in ['xoy', 'xoz', 'yoz'] as const" :key="plane"><input v-model="clip.planes[plane].visible" type="checkbox">{{ plane.toUpperCase() }}</label>
          <button type="button" @click="saveDisplayClip()">保存显示剖切</button>
        </template>
        <template v-else-if="panel === 'transform'">
          <p>变换会预览到工作模型，并在处理选定 LOD 时应用到每个高斯；边界规则使用变换后的场景坐标。</p>
          <h3>平移 X／Y／Z</h3><div class="editor-clip-row" v-for="(_, axis) in transformDraft.translation" :key="axis"><span>{{ ['X','Y','Z'][axis] }}</span><input v-model.number="transformDraft.translation[axis]" type="number" step="any"></div>
          <h3>旋转角度 X／Y／Z</h3><div class="editor-clip-row" v-for="(_, axis) in transformDraft.rotation_degrees" :key="axis"><span>{{ ['X','Y','Z'][axis] }}</span><input v-model.number="transformDraft.rotation_degrees[axis]" type="number" step="any"></div>
          <label>等比缩放<input v-model.number="transformDraft.scale[0]" type="number" min="0.000001" step="any"></label>
          <button type="button" @click="saveTransform">保存模型变换</button>
        </template>
        <template v-else-if="panel === 'coordinates'">
          <p>文件坐标保持原值；设置文件参考点及其对应的投影坐标原点。头文件提示仅作预填，请核对 EPSG、轴向和高程基准。</p>
          <label>原投影 EPSG<input v-model.number="geographyDraft.source_epsg" type="number" min="1" step="1"></label>
          <label>文件单位换算为米<input v-model.number="geographyDraft.metres_per_unit" type="number" min="0.000001" step="any"></label>
          <h3>文件参考点 X／Y／Z</h3><div class="editor-clip-row" v-for="(_, axis) in geographyDraft.reference" :key="axis"><span>{{ ['X','Y','Z'][axis] }}</span><input v-model.number="geographyDraft.reference[axis]" type="number" step="any"></div>
          <h3>对应投影坐标 E／N／H</h3><div class="editor-clip-row" v-for="(_, axis) in geographyDraft.projected_origin" :key="axis"><span>{{ ['E','N','H'][axis] }}</span><input v-model.number="geographyDraft.projected_origin[axis]" type="number" step="any"></div>
          <h3>东／北／上对应文件轴</h3><label v-for="(_, axis) in geographyDraft.axes" :key="axis">{{ ['东','北','上'][axis] }}<select v-model.number="geographyDraft.axes[axis]"><option v-for="candidate in [1,-1,2,-2,3,-3]" :key="candidate" :value="candidate">{{ candidate > 0 ? '+' : '−' }}{{ ['X','Y','Z'][Math.abs(candidate) - 1] }}</option></select></label>
          <button type="button" @click="saveGeography">保存坐标设置</button>
          <p v-if="lastPoint">场景／文件坐标：{{ lastPoint.map(value => value.toFixed(3)).join('，') }}</p>
          <button type="button" :disabled="coordinateBusy || !lastPoint || !currentState.geography" @click="queryCoordinates">{{ coordinateBusy ? '正在转换…' : '查询取点坐标' }}</button>
          <template v-if="coordinateResult"><p>独立场景坐标：{{ coordinateResult.independent.join('，') }}</p><p>原 EPSG 投影坐标：{{ coordinateResult.projected.join('，') }}</p><p>WGS84：{{ coordinateResult.longitude.toFixed(8) }}°，{{ coordinateResult.latitude.toFixed(8) }}°</p><p>{{ coordinateResult.height_note }}</p></template>
        </template>
        <template v-else-if="panel === 'history'"><ol class="editor-history"><li v-for="(step, index) in task.history" :key="index"><button type="button" :class="{ active: index === task.history_cursor }" @click="jump(index)">{{ index }}．{{ step.label }}<small>{{ formatTaskTime(step.at) }}</small></button></li></ol></template>
        <template v-else>
          <p v-if="task.process_status !== 'not_requested'" role="status">{{ task.process_phase ?? task.process_status }}<template v-if="task.process_level !== null && task.process_level !== undefined"> · LOD {{ task.process_level }}</template><template v-if="task.process_progress !== null && task.process_progress !== undefined"> · {{ task.process_progress }}%</template><br>已完成 {{ task.process_completed ?? 0 }}／{{ task.process_total ?? 0 }} 层 {{ task.process_error }}</p>
          <p v-if="task.export_status && task.export_status !== 'not_requested'" role="status">格式导出：{{ task.export_phase ?? task.export_status }}<template v-if="task.export_progress !== null && task.export_progress !== undefined"> {{ task.export_progress }}%</template> {{ task.export_error }}</p>
          <section v-for="version in task.versions" :key="version.version"><h3>成果 {{ formatTaskTime(version.created_at_unix) }}</h3><p v-for="item in version.levels" :key="item.level">LOD {{ item.level }}：{{ item.source_count.toLocaleString() }} → {{ item.count.toLocaleString() }} 高斯<br><small v-if="item.coordinate_mode === 'manifest'">PLY 不含地理定位；请同时保存坐标说明。</small><small v-else-if="item.coordinate_mode === 'embedded'">编辑后的 EPSG 与投影原点已写入 PLY 头文件。</small><br v-if="item.coordinate_mode === 'manifest' || item.coordinate_mode === 'embedded'"><button type="button" @click="download(version.version, item.level)">下载 PLY</button><button type="button" @click="downloadManifest(version.version, item.level, 'ply')">PLY 坐标说明</button><template v-for="format in ['compressed_ply', 'sog'] as const" :key="format"><template v-if="task.exports?.some(exported => exported.version === version.version && exported.level === item.level && exported.format === format)"><button type="button" @click="download(version.version, item.level, format)">下载 {{ format === 'sog' ? 'SOG' : 'Compressed PLY' }}</button><button type="button" @click="downloadManifest(version.version, item.level, format)">坐标说明</button></template><button v-else type="button" :disabled="taskOperationBusy" @click="convertExport(version.version, item.level, format)">{{ submittingExport === `${version.version}:${item.level}:${format}` ? '正在提交导出…' : `生成 ${format === 'sog' ? 'SOG' : 'Compressed PLY'}` }}</button></template></p></section>
          <p v-if="!task.versions.length">暂无完整成果</p>
        </template>
      </aside>
      <p v-if="downloadProgress" class="editor-download-progress" role="status">正在保存成果：{{ (downloadProgress.loaded / 1048576).toFixed(1) }} MiB<template v-if="downloadProgress.total">／{{ (downloadProgress.total / 1048576).toFixed(1) }} MiB（{{ Math.round(downloadProgress.loaded * 100 / downloadProgress.total) }}%）</template></p>
      <p v-if="message" class="editor-message" role="status">{{ message }}</p>
    </div>
    <p v-if="message && !task" role="status" class="editor-entry-message">{{ message }}</p>
  </main>
</template>

<style scoped>
.editor-page { min-height: 100vh; background: #08111d; color: #edf5ff; }
.editor-page button, .editor-page select, .editor-page input { font: inherit; }
.editor-page button { cursor: pointer; }
.editor-page button:disabled { cursor: default; opacity: .5; }
.editor-page a { color: #78d6b8; }
.editor-upload { display: grid; gap: 12px; margin-bottom: 14px; }.editor-upload p { margin: 0; color: #adbed2; }
.module-entry-card > button { padding: 9px 14px; border: 1px solid #4a6a84; border-radius: 6px; color: #edf5ff; background: #15324b; }
.module-entry-card progress { display: block; width: 100%; margin-top: 8px; }
.module-entry-history-list small { display: block; color: #adbed2; }
.editor-workspace { display: flex; flex-direction: column; height: 100vh; min-height: 0; overflow: hidden; }
.editor-stage { position: relative; flex: 1; min-height: 0; }.editor-wait { display: grid; place-items: center; height: 100%; }
.editor-panel { position: absolute; z-index: 5; top: 60px; bottom: 58px; left: 12px; box-sizing: border-box; width: min(360px, calc(100% - 24px)); overflow: auto; padding: 14px; border: 1px solid #42617d; border-radius: 9px; background: #102136f2; box-shadow: 0 12px 36px #0008; }
.editor-panel-history, .editor-panel-results { right: 12px; left: auto; }
.editor-panel header { display: flex; justify-content: space-between; align-items: center; }.editor-panel header h2 { margin: 0 0 12px; font-size: 18px; }
.editor-panel button { margin: 3px; padding: 7px 9px; border: 1px solid #4a6a84; border-radius: 6px; color: #edf5ff; background: #17334c; }
.editor-panel label { display: block; margin: 10px 0; }.editor-panel :is(input[type=number], select) { box-sizing: border-box; width: 100%; margin-top: 4px; padding: 7px; border: 1px solid #42617d; border-radius: 5px; background: #091828; color: #edf5ff; }
.editor-panel input[type=checkbox] { margin-right: 7px; }.editor-panel p { color: #c0d1e0; line-height: 1.45; }
.editor-size { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }.editor-rule { display: flex; align-items: center; justify-content: space-between; gap: 6px; border-top: 1px solid #324b63; }
.editor-quaternion { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.editor-clip-row { display: grid; grid-template-columns: 20px 1fr 1fr; gap: 6px; margin: 6px 0; }.editor-clip-row input { min-width: 0; padding: 6px; border: 1px solid #42617d; border-radius: 5px; background: #091828; color: #edf5ff; }
.editor-vertex-row { grid-template-columns: 20px 1fr 1fr auto; }
.editor-history { padding-left: 0; list-style: none; }.editor-history button { display: block; width: 100%; text-align: left; }.editor-history button.active { border-color: #78d6b8; color: #78d6b8; }.editor-history small { display: block; color: #a8bbcc; }
.editor-message { position: absolute; z-index: 6; left: 12px; bottom: 56px; max-width: min(600px, calc(100% - 24px)); padding: 9px 12px; border: 1px solid #78d6b8; border-radius: 6px; background: #12382f; }
.editor-download-progress { position: absolute; z-index: 6; right: 12px; bottom: 44px; margin: 0; padding: 7px 10px; border-radius: 6px; background: #102136e8; }
.editor-entry-message { margin: 0 auto; width: min(1040px, calc(100% - 40px)); }
</style>
