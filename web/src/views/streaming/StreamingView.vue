<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useWorkspaceStore } from '../../stores/workspace-store';
import TransformEditor from '../../components/home/TransformEditor.vue';
import ModuleTopbar from '../../components/ModuleTopbar.vue';
import SingleModelViewport from './SingleModelViewport.vue';
import './streaming-workbench.css';
import type { TransformParameters } from '../../coordinate-math';
import { pickDirectory } from '../../shared/directory-selection';
import { createStreamingTask, downloadStreamingCache, generateStreamedCache,
  listStreamingTasks, loadStreamingTask, saveStreamingTransform, type StreamingInputKind,
  releaseStreamingSource, retainStreamingSource, type StreamingTask } from '../../api/streaming-api';

const route = useRoute();
const router = useRouter();
const workspace = useWorkspaceStore();
const kind = ref<StreamingInputKind>('single');
const selected = ref<File[]>([]);
const paths = ref<string[]>([]);
const tasks = ref<StreamingTask[]>([]);
const task = ref<StreamingTask | null>(null);
const transform = ref<TransformParameters>({ translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] });
const busy = ref(false);
const historyOpen = ref(false);
const message = ref('');
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const fallbackDirectoryInput = ref<HTMLInputElement>();
const downloadHandles = new Map<string, Awaited<ReturnType<typeof downloadStreamingCache>>>();
const downloads = ref<Record<string, { received: number; status: 'downloading' | 'ready' | 'failed'; error: string }>>({});
const downloadState = computed(() => task.value ? downloads.value[task.value.task_id] : undefined);
let timer: ReturnType<typeof setInterval> | undefined;
let loadedTaskId = '';

function choose(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  selected.value = files;
  paths.value = files.map(file => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
  if (kind.value === 'lod_group') {
    const numbered = files.map((file, index) => ({ file, path: paths.value[index] }));
    numbered.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }));
    selected.value = numbered.map(item => item.file);
    paths.value = numbered.map(item => item.path);
  }
}
async function chooseDirectory() {
  try {
    const selection = await pickDirectory(() => fallbackDirectoryInput.value?.click());
    if (!selection) return;
    selected.value = selection.files;
    paths.value = selection.paths;
    message.value = selection.files.length ? '' : '所选目录中没有文件';
  } catch (error) { fail(error); }
}
function cacheProgress(value: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}
function move(index: number, direction: number) {
  const target = index + direction;
  if (target < 0 || target >= selected.value.length) return;
  [selected.value[index], selected.value[target]] = [selected.value[target], selected.value[index]];
  [paths.value[index], paths.value[target]] = [paths.value[target], paths.value[index]];
}
function fail(error: unknown) { message.value = error instanceof Error ? error.message : String(error); }
function notify(value: string) { message.value = ''; message.value = value; }
watch(message, value => {
  if (toastTimer) clearTimeout(toastTimer);
  if (value) toastTimer = setTimeout(() => { message.value = ''; }, 5000);
}, { flush: 'sync' });
async function refresh() {
  try {
    tasks.value = await listStreamingTasks(workspace.workspaceId);
    const id = route.params.taskId;
    if (typeof id === 'string') {
      task.value = await loadStreamingTask(id);
      if (loadedTaskId !== id) {
        transform.value = task.value.business_transform;
        loadedTaskId = id;
      }
    } else { task.value = null; loadedTaskId = ''; }
  } catch (error) { fail(error); }
}
async function submit() {
  if (!selected.value.length) { message.value = '请先选择文件'; return; }
  busy.value = true; message.value = '';
  try {
    const created = await createStreamingTask({ kind: kind.value, workspaceId: workspace.workspaceId,
      file: kind.value === 'single' || (kind.value === 'dataset' && selected.value.length === 1 && selected.value[0].name.toLowerCase().endsWith('.zip')) ? selected.value[0] : undefined,
      files: kind.value === 'lod_group' || (kind.value === 'dataset' && !selected.value[0].name.toLowerCase().endsWith('.zip')) ? selected.value : undefined,
      paths: paths.value, transform: transform.value });
    await router.push({ name: 'streaming-task', params: { taskId: created.task_id } });
    await refresh();
  } catch (error) { fail(error); }
  finally { busy.value = false; }
}
let transformSaves = Promise.resolve();
watch(transform, value => {
  const id = task.value?.task_id;
  if (!id || loadedTaskId !== id || route.params.taskId !== id) return;
  const snapshot = JSON.parse(JSON.stringify(value)) as TransformParameters;
  transformSaves = transformSaves.then(async () => {
    try { await saveStreamingTransform(id, snapshot); }
    catch (error) { notify(`业务矩阵自动保存失败：${error instanceof Error ? error.message : String(error)}，请重新编辑后重试`); }
  });
}, { deep: true, flush: 'sync' });
async function generate() {
  if (!task.value) return;
  busy.value = true; message.value = '';
  try { task.value = await generateStreamedCache(task.value.task_id); }
  catch (error) { fail(error); }
  finally { busy.value = false; }
}
async function download() {
  if (!task.value) return;
  const current = task.value;
  downloads.value[current.task_id] = { received: 0, status: 'downloading', error: '' };
  const state = downloads.value[current.task_id];
  busy.value = true; message.value = '';
  try {
    await downloadStreamingCache(current.task_id, current.filename, {
      handle: downloadHandles.get(current.task_id),
      onHandle: handle => { downloadHandles.set(current.task_id, handle); },
      onProgress: received => { state.received = received; },
    });
    downloadHandles.delete(current.task_id);
    state.status = 'ready';
    notify('流式数据下载完成');
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError' && !downloadHandles.has(current.task_id)) {
      delete downloads.value[current.task_id];
      return;
    }
    state.status = 'failed';
    state.error = `下载失败：${error instanceof Error ? error.message : String(error)}。残缺文件未保存，可从头重试。`;
  }
  finally { busy.value = false; }
}
async function retain() {
  if (!task.value) return;
  busy.value = true; message.value = '';
  try { task.value = await retainStreamingSource(task.value.task_id); message.value = '源数据已延长保留'; }
  catch (error) { fail(error); } finally { busy.value = false; }
}
async function release() {
  if (!task.value || !confirm('将删除此流式任务的源文件、计算文件和预览，只保留已生成的流式输出。是否继续？')) return;
  busy.value = true; message.value = '';
  try { task.value = await releaseStreamingSource(task.value.task_id); message.value = '源数据已释放'; }
  catch (error) { fail(error); } finally { busy.value = false; }
}
watch(() => route.params.taskId, refresh);
onMounted(() => { void refresh(); timer = setInterval(() => { void refresh(); }, 2500); });
onUnmounted(() => { if (timer) clearInterval(timer); if (toastTimer) clearTimeout(toastTimer); });
</script>

<template>
  <main class="streaming-page" :class="{ 'streaming-workbench': task }">
    <ModuleTopbar title="高斯流式数据处理" mark="S"><template #actions>
      <button type="button" @click="historyOpen = !historyOpen" :aria-expanded="historyOpen">历史任务</button>
      <RouterLink v-if="task" to="/streaming">新建任务</RouterLink>
    </template></ModuleTopbar>
    <p v-if="!task">导入模型或按精细到粗略排序的 LOD 文件组，生成LOD流式数据。</p>
    <p v-if="message && !task" class="page-message" role="status">{{ message }}</p>
    <section v-if="!task" class="streaming-panel new-task-panel">
      <h2>新建任务</h2>
      <label>输入方式
        <select v-model="kind" @change="selected = []; paths = []">
          <option value="single">单个高斯文件</option><option value="dataset">完整数据集目录或 ZIP</option>
          <option value="lod_group">已有 LOD 文件组</option>
        </select>
      </label>
      <input v-if="kind === 'single'" type="file" accept=".ply,.spz,.sog" @change="choose">
      <input v-else-if="kind === 'lod_group'" type="file" multiple accept=".ply" @change="choose">
      <template v-else>
        <label>ZIP 文件<input type="file" accept=".zip" @change="choose"></label>
        <button type="button" @click="chooseDirectory">选择数据集目录</button>
        <input ref="fallbackDirectoryInput" hidden type="file" webkitdirectory multiple @change="choose">
      </template>
      <ol v-if="kind === 'lod_group' && selected.length">
        <li v-for="(file, index) in selected" :key="file.name + index">
          LOD {{ index }}：{{ file.name }}
          <button type="button" :disabled="index === 0" @click="move(index, -1)">上移</button>
          <button type="button" :disabled="index === selected.length - 1" @click="move(index, 1)">下移</button>
        </li>
      </ol>
      <p v-if="selected.length">已选择 {{ selected.length }} 个文件。<template v-if="kind === 'lod_group'">LOD 0 为最精细层，请确认顺序。</template></p>
      <TransformEditor model="a" v-model="transform" external-feedback @notify="notify" />
      <button class="create-task-action" type="button" :disabled="busy || !selected.length" @click="submit">创建任务</button>
    </section>
    <section v-else class="streaming-panel task-workspace">
      <aside class="task-sidebar">
      <h2>{{ task.filename }}</h2>
      <p>模型状态：{{ task.status }}；流式数据：{{ task.cache_status }}<span v-if="cacheProgress(task.cache_progress) !== undefined">（{{ cacheProgress(task.cache_progress) }}%）</span></p>
      <progress v-if="task.cache_status === 'queued' || task.cache_status === 'converting'"
        aria-label="流式数据生成进度" :value="cacheProgress(task.cache_progress)" max="100" />
      <p v-if="task.metadata">原始点数：{{ task.metadata.source_point_count.toLocaleString() }}；预览点数：{{ task.metadata.preview_point_count.toLocaleString() }}</p>
      <TransformEditor model="a" v-model="transform" external-feedback @notify="notify" />
      <button v-if="task.cache_status === 'ready'" type="button" :disabled="busy" @click="download">{{ downloadState?.status === 'failed' ? '重新下载 ZIP' : '下载 ZIP' }}</button>
      <p v-if="downloadState">已接收 {{ downloadState.received.toLocaleString() }} 字节（{{ (downloadState.received / 1024 / 1024).toFixed(1) }} MB）<span v-if="downloadState.status === 'ready'">，下载完成</span></p>
      <div id="streaming-coordinate-settings"></div>
      </aside>
      <div class="scene-stage">
      <SingleModelViewport v-if="task.status === 'ready' && task.preview_url && task.metadata" :key="task.task_id" :task-id="task.task_id"
        @notify="notify"
        :url="task.preview_url" :origin="task.metadata.origin" v-model:transform="transform"
        :original-url="task.gaussian_url" :original-filename="task.gaussian_filename"
        :cache-url="task.cache_url" :lods="task.lods"><template #task-actions>
        <button type="button" :disabled="busy || task.status !== 'ready' || task.cache_status === 'queued' || task.cache_status === 'converting'" @click="generate">{{ task.cache_status === 'failed' ? '重试生成' : '生成流式数据' }}</button>
        <button type="button" :disabled="busy || task.source_available === false" @click="retain">再保留 24 小时</button>
        <button type="button" :disabled="busy || task.source_available === false" @click="release">{{ task.source_available === false ? '源数据已释放' : '释放源数据' }}</button>
      </template></SingleModelViewport>
      <div v-else class="scene-placeholder"><div class="task-actions-fallback">
        <button type="button" :disabled="busy || task.status !== 'ready' || task.cache_status === 'queued' || task.cache_status === 'converting'" @click="generate">{{ task.cache_status === 'failed' ? '重试生成' : '生成流式数据' }}</button>
        <button type="button" :disabled="busy || task.source_available === false" @click="retain">再保留 24 小时</button>
        <button type="button" :disabled="busy || task.source_available === false" @click="release">{{ task.source_available === false ? '源数据已释放' : '释放源数据' }}</button>
      </div>{{ task.source_available === false ? '源数据已释放，仍可下载已生成的流式数据' : task.status === 'failed' ? '模型准备失败，请查看任务提示' : '正在准备三维模型……' }}</div>
      <div class="scene-notifications">
        <p v-if="message" role="status">{{ message }}</p>
        <p v-if="task.error || task.cache_error" role="alert">{{ task.error || task.cache_error }}</p>
        <p v-if="downloadState?.status === 'failed'" role="alert">{{ downloadState.error }}</p>
      </div>
      </div>
    </section>
    <section v-if="!task || historyOpen" class="streaming-panel history-panel"><header><h2>历史任务</h2><button v-if="task" @click="historyOpen = false" aria-label="关闭历史任务">×</button></header><p v-if="!tasks.length">暂无任务</p>
      <ul><li v-for="item in tasks" :key="item.task_id"><RouterLink :to="`/streaming/${item.task_id}`">{{ item.filename }}</RouterLink> · {{ item.status }} · {{ item.cache_status }}<span v-if="cacheProgress(item.cache_progress) !== undefined">（{{ cacheProgress(item.cache_progress) }}%）</span></li></ul>
    </section>
  </main>
</template>

<style scoped>
.streaming-page { min-height: 100vh; padding: 0; background: #08111d; color: #edf5ff; }
.streaming-page:not(.streaming-workbench) > :is(p, .streaming-panel) { box-sizing: border-box; width: min(1040px, calc(100% - 48px)); margin-left: auto; margin-right: auto; }
header a, a { color: #78d6b8; } h1 { margin: 14px 0; } h2 { margin-top: 0; }
.streaming-panel { margin: 24px 0; padding: 24px; border: 1px solid #385574; border-radius: 14px; background: #17283d; }
.streaming-page.streaming-workbench { padding: 0; }
.streaming-workbench .task-workspace { margin: 0; padding: 0; border: 0; border-radius: 0; }
label { display: block; margin: 12px 0; } input, select, button { margin: 6px; padding: 8px; }
button { cursor: pointer; } button:disabled { cursor: default; opacity: .5; }
.new-task-panel select { min-height: 36px; padding: 0 12px; border: 1px solid #385574; border-radius: 8px; color: #edf5ff; background: #0a1623; font: inherit; cursor: pointer; transition: border-color .18s, background .18s, box-shadow .18s; }
.new-task-panel button, .new-task-panel input[type="file"]::file-selector-button { min-height: 36px; padding: 7px 11px; border: 1px solid #385574; border-radius: 7px; color: #78d6b8; background: #122238; font: inherit; cursor: pointer; transition: border-color .18s, background .18s, box-shadow .18s; }
.new-task-panel input[type="file"] { color: #adbed2; font: inherit; }
.new-task-panel input[type="file"]::file-selector-button { margin-right: 10px; }
.new-task-panel select:hover, .new-task-panel button:not(:disabled):hover, .new-task-panel input[type="file"]::file-selector-button:hover { border-color: #65d6b2; background: #17364a; box-shadow: 0 0 0 2px #45c39a24; }
.new-task-panel button.create-task-action { color: #06140f; border-color: #6be0ba; background: linear-gradient(135deg, #65d9b4, #35b388); font-weight: 750; }
.new-task-panel button.create-task-action:not(:disabled):hover { border-color: #a3f5d8; filter: brightness(1.1); }
.new-task-panel button:disabled { border-color: #344354; color: #77879a; background: #1b2633; cursor: not-allowed; }
.new-task-panel :is(select, button, input):focus-visible { outline: 2px solid #75d6b8; outline-offset: 2px; }
li { margin: 8px 0; }
</style>
