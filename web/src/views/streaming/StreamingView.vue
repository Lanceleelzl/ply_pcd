<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useWorkspaceStore } from '../../stores/workspace-store';
import TransformEditor from '../../components/home/TransformEditor.vue';
import SingleModelViewport from './SingleModelViewport.vue';
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
const message = ref('');
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
async function saveTransform() {
  if (!task.value) return;
  busy.value = true; message.value = '';
  try { task.value = await saveStreamingTransform(task.value.task_id, transform.value); message.value = '业务矩阵已保存'; }
  catch (error) { fail(error); }
  finally { busy.value = false; }
}
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
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <main class="streaming-page">
    <header><RouterLink to="/">← 工具箱首页</RouterLink><h1>高斯流式数据处理</h1></header>
    <p>导入模型或按精细到粗略排序的 LOD 文件组，生成可下载的流式数据。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <section v-if="!task" class="panel">
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
      <TransformEditor model="a" v-model="transform" />
      <button type="button" :disabled="busy || !selected.length" @click="submit">创建任务</button>
    </section>
    <section v-else class="panel">
      <h2>{{ task.filename }}</h2>
      <p>模型状态：{{ task.status }}；流式数据：{{ task.cache_status }}<span v-if="cacheProgress(task.cache_progress) !== undefined">（{{ cacheProgress(task.cache_progress) }}%）</span></p>
      <progress v-if="task.cache_status === 'queued' || task.cache_status === 'converting'"
        aria-label="流式数据生成进度" :value="cacheProgress(task.cache_progress)" max="100" />
      <p v-if="task.error || task.cache_error" role="alert">{{ task.error || task.cache_error }}</p>
      <p v-if="task.metadata">原始点数：{{ task.metadata.source_point_count.toLocaleString() }}；预览点数：{{ task.metadata.preview_point_count.toLocaleString() }}</p>
      <SingleModelViewport v-if="task.status === 'ready' && task.preview_url && task.metadata"
        :url="task.preview_url" :origin="task.metadata.origin" :transform="transform"
        :original-url="task.gaussian_url" :original-filename="task.gaussian_filename"
        :cache-url="task.cache_url" :lods="task.lods" />
      <TransformEditor model="a" v-model="transform" />
      <button type="button" :disabled="busy" @click="saveTransform">保存业务矩阵</button>
      <button type="button" :disabled="busy || task.status !== 'ready' || task.cache_status === 'queued' || task.cache_status === 'converting'" @click="generate">{{ task.cache_status === 'failed' ? '重试生成' : '生成流式数据' }}</button>
      <button v-if="task.cache_status === 'ready'" type="button" :disabled="busy" @click="download">{{ downloadState?.status === 'failed' ? '重新下载 ZIP' : '下载 ZIP' }}</button>
      <button type="button" :disabled="busy || task.source_available === false" @click="retain">再保留 24 小时</button>
      <button type="button" :disabled="busy || task.source_available === false" @click="release">{{ task.source_available === false ? '源数据已释放' : '释放源数据' }}</button>
      <p v-if="downloadState">已接收 {{ downloadState.received.toLocaleString() }} 字节（{{ (downloadState.received / 1024 / 1024).toFixed(1) }} MB）<span v-if="downloadState.status === 'ready'">，下载完成</span></p>
      <p v-if="downloadState?.status === 'failed'" role="alert">{{ downloadState.error }}</p>
    </section>
    <section class="panel"><h2>历史任务</h2><p v-if="!tasks.length">暂无任务</p>
      <ul><li v-for="item in tasks" :key="item.task_id"><RouterLink :to="`/streaming/${item.task_id}`">{{ item.filename }}</RouterLink> · {{ item.status }} · {{ item.cache_status }}<span v-if="cacheProgress(item.cache_progress) !== undefined">（{{ cacheProgress(item.cache_progress) }}%）</span></li></ul>
    </section>
  </main>
</template>

<style scoped>
.streaming-page { min-height: 100vh; padding: 32px max(24px, calc((100vw - 1040px) / 2)); background: #08111d; color: #edf5ff; }
header a, a { color: #78d6b8; } h1 { margin: 14px 0; } h2 { margin-top: 0; }
.panel { margin: 24px 0; padding: 24px; border: 1px solid #385574; border-radius: 14px; background: #17283d; }
label { display: block; margin: 12px 0; } input, select, button { margin: 6px; padding: 8px; }
button { cursor: pointer; } button:disabled { cursor: default; opacity: .5; }
li { margin: 8px 0; }
</style>
