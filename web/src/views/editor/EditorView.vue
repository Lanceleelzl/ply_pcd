<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { apiFetch } from '../../api/api-auth';
import { createEditorTask, decimateEditorTask, editorDownloadUrl, jumpEditorHistory,
  listEditorTasks, loadEditorTask, processEditorTask, queryEditorCoordinates, recordEditorEdit,
  type EditorGeography, type EditorInputKind, type EditorRule, type EditorState, type EditorTask } from '../../api/gaussian-editor-api';
import ModuleTopbar from '../../components/ModuleTopbar.vue';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { formatTaskTime } from '../../shared/task-time';
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
const busy = ref(false);
const phase = ref('');
const uploaded = ref(0);
const uploadTotal = ref(0);
const message = ref('');
const panel = ref<'lod' | 'bounds' | 'slice' | 'coordinates' | 'history' | 'results' | null>('lod');
const geographyDraft = ref<EditorGeography>({ reference: [0, 0, 0], projected_origin: [0, 0, 0],
  axes: [1, 2, 3], metres_per_unit: 1, source_epsg: 0 });
const coordinateResult = ref<{ independent: XYZ; projected: XYZ; longitude: number; latitude: number; height_note: string } | null>(null);
const coordinateBusy = ref(false);
let geographyTaskId = '';
function copyGeography(frame: EditorGeography): EditorGeography {
  return { ...frame, reference: [...frame.reference], projected_origin: [...frame.projected_origin], axes: [...frame.axes] };
}
const clip = ref<{ mode: 'off' | 'axis' | 'box'; min: XYZ; max: XYZ; center: XYZ; size: XYZ;
  planes: Record<'xoy' | 'xoz' | 'yoz', { visible: boolean; side: number }> }>({
    mode: 'off', min: [-1e30, -1e30, -1e30], max: [1e30, 1e30, 1e30],
    center: [0, 0, 0], size: [1, 1, 1],
    planes: { xoy: { visible: false, side: 1 }, xoz: { visible: false, side: 1 }, yoz: { visible: false, side: 1 } },
  });
const clipThickness = ref(1);
const workLevel = ref(0);
const useDerived = ref(false);
const lastPoint = ref<XYZ | null>(null);
const polygonDraft = ref<[number, number][]>([]);
const boundaryAction = ref<'keep' | 'remove'>('keep');
const sphereRadius = ref(1);
const boxSize = ref<XYZ>([1, 1, 1]);
const targetCount = ref(100_000);
let timer: ReturnType<typeof setInterval> | null = null;

const currentState = computed<EditorState>(() => task.value?.history[task.value.history_cursor]?.state
  ?? { rules: [], selected_lods: [] });
const selectedLod = computed(() => task.value?.lods.find(item => item.level === workLevel.value));
const selectedDerived = computed(() => task.value?.derived_lods.filter(item => item.source_level === workLevel.value).at(-1));
const currentUrl = computed(() => useDerived.value && selectedDerived.value ? selectedDerived.value.gaussian_url : selectedLod.value?.gaussian_url ??
  (workLevel.value === 0 ? task.value?.gaussian_url : undefined));
const currentFilename = computed(() => useDerived.value && selectedDerived.value ? 'work-lod.ply' :
  selectedLod.value?.name ?? task.value?.gaussian_filename ?? task.value?.filename ?? 'model.ply');
const levelCount = computed(() => useDerived.value && selectedDerived.value ? selectedDerived.value.count :
  selectedLod.value?.level === (task.value?.lods.length ?? 0) - 1
  || (task.value?.available_levels.length === 1 && workLevel.value === 0)
  ? task.value?.metadata?.source_point_count : undefined);

async function refresh(): Promise<void> {
  const id = route.params.taskId;
  try {
    if (typeof id === 'string') {
      const loaded = await loadEditorTask(id);
      task.value = loaded;
      if (geographyTaskId !== id) {
        geographyTaskId = id;
        geographyDraft.value = copyGeography(loaded.history[loaded.history_cursor]?.state.geography ?? {
          reference: [0, 0, 0],
          projected_origin: loaded.coordinate_metadata?.offset.map(value => Number(value ?? 0)) ?? [0, 0, 0],
          axes: [1, 2, 3], metres_per_unit: 1, source_epsg: Number(loaded.coordinate_metadata?.epsg ?? 0),
        } as EditorGeography);
        coordinateResult.value = null;
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
onUnmounted(() => { if (timer) clearInterval(timer); });

function selectFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  files.value = Array.from(input.files ?? []);
  paths.value = files.value.map(file => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
}
async function create(): Promise<void> {
  if (!files.value.length || busy.value) return;
  busy.value = true; message.value = ''; phase.value = '上传中'; uploaded.value = 0; uploadTotal.value = 0;
  try {
    const created = await createEditorTask({ kind: kind.value, workspaceId: workspace.workspaceId,
      file: kind.value === 'lod_group' || kind.value === 'dataset' && files.value.length > 1 ? undefined : files.value[0],
      files: kind.value === 'lod_group' || kind.value === 'dataset' && files.value.length > 1 ? files.value : undefined,
      paths: paths.value,
      onProgress: (loaded, total) => { uploaded.value = loaded; uploadTotal.value = total; },
    });
    phase.value = '服务端预读与生成场景预览';
    await router.push(`/editor/${created.task_id}`);
  } catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { busy.value = false; }
}
async function saveEdit(label: string, state: EditorState): Promise<void> {
  if (!task.value) return;
  try { task.value = await recordEditorEdit(task.value.task_id, label, state); message.value = ''; }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
}
function addRule(rule: EditorRule, label: string): void {
  void saveEdit(label, { ...currentState.value, rules: [...currentState.value.rules, rule] });
}
function addPolygon(): void {
  if (polygonDraft.value.length < 3) { message.value = '平面边界至少需要三个取点'; return; }
  addRule({ type: 'polygon', action: boundaryAction.value, points: polygonDraft.value.map(point => [...point]) }, '新增平面边界');
  polygonDraft.value = [];
}
function addSphere(): void {
  if (!lastPoint.value) { message.value = '先在场景中取一个球心'; return; }
  addRule({ type: 'sphere', action: boundaryAction.value, center: [...lastPoint.value], radius: sphereRadius.value }, '新增球形边界');
}
function addBox(): void {
  if (!lastPoint.value) { message.value = '先在场景中取一个中心点'; return; }
  addRule({ type: 'box', action: boundaryAction.value, center: [...lastPoint.value], size: [...boxSize.value],
    rotation: [1, 0, 0, 0] }, '新增长方体边界');
}
function removeRule(index: number): void {
  void saveEdit('移除边界', { ...currentState.value, rules: currentState.value.rules.filter((_, i) => i !== index) });
}
function picked(point: XYZ): void {
  lastPoint.value = point;
  if (panel.value === 'bounds') polygonDraft.value.push([point[0], point[1]]);
  coordinateResult.value = null;
}
async function saveGeography(): Promise<void> {
  const frame = copyGeography(geographyDraft.value);
  if (!Number.isInteger(frame.source_epsg) || frame.source_epsg <= 0
    || frame.metres_per_unit <= 0 || ![...frame.reference, ...frame.projected_origin].every(Number.isFinite)) {
    message.value = '请输入有效 EPSG、参考坐标、投影原点和单位'; return;
  }
  await saveEdit('修改坐标原点', { ...currentState.value, geography: frame });
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
}
async function jump(index: number): Promise<void> {
  if (!task.value) return;
  try { task.value = await jumpEditorHistory(task.value.task_id, index);
    if (task.value.history[index]?.state.geography) geographyDraft.value = copyGeography(task.value.history[index].state.geography);
    coordinateResult.value = null;
  }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
}
function toggleLevel(level: number, checked: boolean): void {
  const levels = checked ? [...currentState.value.selected_lods, level] : currentState.value.selected_lods.filter(item => item !== level);
  void saveEdit('修改目标层级', { ...currentState.value, selected_lods: [...new Set(levels)].sort((a, b) => a - b) });
}
async function run(): Promise<void> {
  if (!task.value || !currentState.value.selected_lods.length) return;
  try { task.value = await processEditorTask(task.value.task_id, currentState.value.selected_lods); panel.value = 'results'; }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
}
async function decimate(): Promise<void> {
  if (!task.value) return;
  try { task.value = await decimateEditorTask(task.value.task_id, workLevel.value, targetCount.value); panel.value = 'lod'; }
  catch (error) { message.value = error instanceof Error ? error.message : String(error); }
}
async function download(version: string, level: number): Promise<void> {
  if (!task.value) return;
  const picker = (window as typeof window & { showSaveFilePicker?: (options: { suggestedName: string }) =>
    Promise<{ createWritable(): Promise<{ write(value: Uint8Array): Promise<void>; close(): Promise<void> }> }> }).showSaveFilePicker;
  if (!picker) { message.value = '当前浏览器不支持大文件流式保存，请使用 Chrome 或 Edge'; return; }
  try {
    const handle = await picker({ suggestedName: `lod-${level}-edited.ply` });
    const response = await apiFetch(editorDownloadUrl(task.value.task_id, version, level));
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    const writable = await handle.createWritable();
    const reader = response.body.getReader();
    while (true) { const { value, done } = await reader.read(); if (done) break; await writable.write(value); }
    await writable.close(); message.value = '成果下载完成';
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
            <label>输入方式<select v-model="kind"><option value="single">单个高斯文件</option><option value="lod_group">有序 LOD 文件组</option><option value="dataset">完整数据集 ZIP／目录</option></select></label>
            <input v-if="kind === 'single'" type="file" accept=".ply,.sog,.spz" @change="selectFiles">
            <input v-else-if="kind === 'lod_group'" type="file" accept=".ply" multiple @change="selectFiles">
            <input v-else type="file" accept=".zip" @change="selectFiles">
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
        :gaussian-url="currentUrl" :filename="currentFilename" :origin="task.metadata.origin"
        :point-count="levelCount" :lod-label="`LOD ${workLevel}`" :clip="clip" @pick="picked" @notify="message = $event">
        <template #tools>
          <button type="button" @click="panel = panel === 'lod' ? null : 'lod'">层级／抽稀</button>
          <button type="button" @click="panel = panel === 'bounds' ? null : 'bounds'">边界</button>
          <button type="button" @click="panel = panel === 'slice' ? null : 'slice'">剖切</button>
          <button type="button" @click="panel = panel === 'coordinates' ? null : 'coordinates'">坐标</button>
          <button type="button" :disabled="task.history_cursor === 0" @click="jump(task.history_cursor - 1)">撤销</button>
          <button type="button" :disabled="task.history_cursor >= task.history.length - 1" @click="jump(task.history_cursor + 1)">重做</button>
          <button type="button" @click="panel = panel === 'history' ? null : 'history'">历史操作</button>
          <button type="button" @click="panel = panel === 'results' ? null : 'results'">成果</button>
        </template>
      </EditorViewport>
      <div v-else class="editor-wait" role="status">{{ task.status === 'failed' ? task.error : '正在预读模型并生成轻量场景预览…' }}</div>
      <aside v-if="panel" class="editor-panel" :class="`editor-panel-${panel}`">
        <header><h2>{{ { lod: '层级与抽稀', bounds: '裁剪边界', slice: '显示剖切', coordinates: '坐标与原点', history: '历史操作', results: '处理成果' }[panel] }}</h2><button type="button" @click="panel = null" aria-label="关闭面板">×</button></header>
        <template v-if="panel === 'lod'">
          <label>工作 LOD<select v-model.number="workLevel" @change="useDerived = false"><option v-for="level in task.available_levels" :key="level" :value="level">LOD {{ level }}</option></select></label>
          <p>只加载当前工作层；其他层级在执行时由服务端处理。</p>
          <label>抽稀目标高斯数<input v-model.number="targetCount" type="number" min="1" step="1"></label>
          <button type="button" :disabled="task.status !== 'ready' || task.decimate_status === 'running' || task.decimate_status === 'queued'" @click="decimate">生成轻量工作层</button>
          <p v-if="task.decimate_status !== 'not_requested'" role="status">抽稀：{{ task.decimate_phase ?? task.decimate_status }}<template v-if="task.decimate_progress !== null && task.decimate_progress !== undefined"> {{ task.decimate_progress }}%</template> {{ task.decimate_error }}</p>
          <p v-for="item in task.derived_lods" :key="item.version">派生自 LOD {{ item.source_level }}：{{ item.count.toLocaleString() }} 高斯
            <button v-if="item.source_level === workLevel" type="button" @click="useDerived = true">用作工作层</button></p>
          <p v-if="useDerived">当前选用派生工作层；正式处理仍从所选原始 LOD 读取。</p>
          <h3>应用规则到</h3><label v-for="level in task.available_levels" :key="level"><input type="checkbox" :checked="currentState.selected_lods.includes(level)" @change="toggleLevel(level, ($event.target as HTMLInputElement).checked)">LOD {{ level }}</label>
          <button type="button" :disabled="!currentState.selected_lods.length || task.process_status === 'running' || task.process_status === 'queued'" @click="run">处理选中层级</button>
        </template>
        <template v-else-if="panel === 'bounds'">
          <p>开启场景取点后逐点点击；平面边界沿模型全高生效。</p>
          <p v-if="lastPoint">当前取点：{{ lastPoint.map(value => value.toFixed(3)).join('，') }}</p>
          <label>边界规则<select v-model="boundaryAction"><option value="keep">保留内部</option><option value="remove">剔除内部</option></select></label>
          <p>平面草稿：{{ polygonDraft.length }} 点</p>
          <button type="button" :disabled="polygonDraft.length < 3" @click="addPolygon">完成 2D 平面边界</button>
          <button type="button" :disabled="!polygonDraft.length" @click="polygonDraft = []">清空草稿</button>
          <label>球半径<input v-model.number="sphereRadius" type="number" min="0.001" step="any"></label>
          <button type="button" :disabled="!lastPoint || sphereRadius <= 0" @click="addSphere">以取点为球心添加球体</button>
          <div class="editor-size"><label v-for="(_, axis) in boxSize" :key="axis">{{ ['X','Y','Z'][axis] }} 尺寸<input v-model.number="boxSize[axis]" type="number" min="0.001" step="any"></label></div>
          <button type="button" :disabled="!lastPoint || boxSize.some(value => value <= 0)" @click="addBox">以取点为中心添加长方体</button>
          <h3>已有边界</h3><p v-if="!currentState.rules.length">暂无边界</p>
          <div v-for="(rule, index) in currentState.rules" :key="index" class="editor-rule"><span>{{ index + 1 }}．{{ { polygon: '平面', sphere: '球体', box: '长方体' }[rule.type] }} · {{ rule.action === 'keep' ? '保留内部' : '剔除内部' }}</span><button type="button" @click="removeRule(index)">移除</button></div>
        </template>
        <template v-else-if="panel === 'slice'">
          <p>剖切仅改变场景显示；裁剪导出请使用「边界」规则。</p>
          <label>切片厚度<input v-model.number="clipThickness" type="number" min="0.001" step="any"></label>
          <div><button v-for="plane in ['xoy', 'xoz', 'yoz'] as const" :key="plane" type="button" @click="slice(plane)">{{ plane.toUpperCase() }}</button></div>
          <label>剖切方式<select v-model="clip.mode"><option value="off">关闭</option><option value="axis">三轴范围</option><option value="box">矩形框</option></select></label>
          <template v-if="clip.mode === 'axis'"><div v-for="(_, axis) in clip.min" :key="axis" class="editor-clip-row"><span>{{ ['X','Y','Z'][axis] }}</span><input v-model.number="clip.min[axis]" type="number" step="any" :aria-label="`${['X','Y','Z'][axis]} 最小值`"><input v-model.number="clip.max[axis]" type="number" step="any" :aria-label="`${['X','Y','Z'][axis]} 最大值`"></div></template>
          <template v-if="clip.mode === 'box'"><div v-for="(_, axis) in clip.center" :key="axis" class="editor-clip-row"><span>{{ ['X','Y','Z'][axis] }}</span><input v-model.number="clip.center[axis]" type="number" step="any" :aria-label="`${['X','Y','Z'][axis]} 中心`"><input v-model.number="clip.size[axis]" type="number" min="0.001" step="any" :aria-label="`${['X','Y','Z'][axis]} 尺寸`"></div></template>
          <h3>原点平面</h3><label v-for="plane in ['xoy', 'xoz', 'yoz'] as const" :key="plane"><input v-model="clip.planes[plane].visible" type="checkbox">{{ plane.toUpperCase() }}</label>
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
          <section v-for="version in task.versions" :key="version.version"><h3>成果 {{ formatTaskTime(version.created_at_unix) }}</h3><p v-for="item in version.levels" :key="item.level">LOD {{ item.level }}：{{ item.source_count.toLocaleString() }} → {{ item.count.toLocaleString() }} 高斯 <button type="button" @click="download(version.version, item.level)">下载 PLY</button></p></section>
          <p v-if="!task.versions.length">暂无完整成果</p>
        </template>
      </aside>
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
.editor-clip-row { display: grid; grid-template-columns: 20px 1fr 1fr; gap: 6px; margin: 6px 0; }.editor-clip-row input { min-width: 0; padding: 6px; border: 1px solid #42617d; border-radius: 5px; background: #091828; color: #edf5ff; }
.editor-history { padding-left: 0; list-style: none; }.editor-history button { display: block; width: 100%; text-align: left; }.editor-history button.active { border-color: #78d6b8; color: #78d6b8; }.editor-history small { display: block; color: #a8bbcc; }
.editor-message { position: absolute; z-index: 6; left: 12px; bottom: 56px; max-width: min(600px, calc(100% - 24px)); padding: 9px 12px; border: 1px solid #78d6b8; border-radius: 6px; background: #12382f; }
.editor-entry-message { margin: 0 auto; width: min(1040px, calc(100% - 40px)); }
</style>
