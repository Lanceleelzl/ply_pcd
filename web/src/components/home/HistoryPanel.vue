<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { downloadStreamCache, listHistory, requestStreamCache, runSessionAction } from '../../api/registration-api';
import type { StreamCacheDownloadHandle, StreamCacheDownloadProgress } from '../../api/registration-api';
import type { HistoryItem, ModelId } from '../../api/contracts';

const props = defineProps<{ workspaceId: string }>();
const emit = defineEmits<{ resume: [sessionId: string] }>();
const items = ref<HistoryItem[]>([]);
const loading = ref(false);
const error = ref('');
const busyId = ref('');
const downloadBusy = ref('');
type DownloadState = StreamCacheDownloadProgress & {
  phase: 'downloading' | 'failed' | 'complete';
  handle?: StreamCacheDownloadHandle;
};
const downloads = ref<Record<string, DownloadState>>({});

const matrixText = (matrix?: number[][]) => matrix?.map(row => row.map(value => Number(value).toFixed(12)).join(' ')).join('\n') ?? '';
const formatTime = (unix?: number) => unix ? new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
const formatBytes = (bytes?: number) => bytes === undefined ? '未知大小' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const downloadKey = (item: HistoryItem, model: ModelId) => `${item.session_id}:${model}`;
const downloadLabel = (item: HistoryItem, model: ModelId): string => {
  const state = downloads.value[downloadKey(item, model)];
  const name = model.toUpperCase();
  if (state?.phase === 'downloading') {
    const total = state.sourceBytes ? `／源数据 ${formatBytes(state.sourceBytes)}` : '';
    return `${name}：已接收 ${formatBytes(state.receivedBytes)}${total}`;
  }
  if (state?.phase === 'failed') return `重新下载 ${name} 流式缓存`;
  if (state?.phase === 'complete') return `再次下载 ${name} 流式缓存`;
  return `下载 ${name} 流式缓存`;
};

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try { items.value = await listHistory(props.workspaceId); }
  catch (reason) { error.value = `历史任务读取失败：${String(reason)}`; }
  finally { loading.value = false; }
}

async function action(item: HistoryItem, name: 'retain' | 'release' | 'resume'): Promise<void> {
  if (name === 'release') {
    const message = item.has_registration_result
      ? '将删除本任务的原始模型、预览缓存和运行日志，只保留最终矩阵与结果摘要。是否继续？'
      : '将删除本任务的原始模型、预览缓存、流式缓存和运行日志；任务尚未完成精配准，释放后不会保留在历史任务中。是否继续？';
    if (!confirm(message)) return;
  }
  busyId.value = item.session_id;
  try {
    await runSessionAction(item.session_id, name, props.workspaceId);
    if (name === 'resume') emit('resume', item.session_id);
    else await load();
  } catch (reason) {
    error.value = `操作失败：${String(reason)}`;
  } finally {
    busyId.value = '';
  }
}

async function copy(item: HistoryItem): Promise<void> {
  await navigator.clipboard.writeText(matrixText(item.recommended_matrix?.value));
}

async function download(item: HistoryItem, model: ModelId): Promise<void> {
  const key = downloadKey(item, model);
  const previous = downloads.value[key];
  downloadBusy.value = key;
  error.value = '';
  downloads.value[key] = { ...previous, phase: 'downloading', receivedBytes: 0, sourceBytes: 0, fileCount: 0 };
  try {
    const handle = await downloadStreamCache(item.session_id, model, props.workspaceId, {
      handle: previous?.handle,
      onHandle: value => { downloads.value[key] = { ...downloads.value[key], handle: value }; },
      onProgress: progress => { downloads.value[key] = { ...downloads.value[key], ...progress }; },
    });
    downloads.value[key] = { ...downloads.value[key], phase: 'complete', handle };
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') {
      if (previous) downloads.value[key] = previous;
      else delete downloads.value[key];
    } else {
      downloads.value[key] = { ...downloads.value[key], phase: 'failed' };
      error.value = `流式缓存下载中断，残缺文件未保存。可点击“重新下载”从头重试：${String(reason)}`;
    }
  } finally {
    downloadBusy.value = '';
  }
}

const cacheStatusText = (item: HistoryItem, model: ModelId): string => {
  const cache = item.stream_caches?.[model];
  if (!cache || cache.status === 'not_requested' || cache.status === 'unavailable') return '';
  if (cache.status === 'queued') return `模型 ${model.toUpperCase()} 流式缓存：等待后台槽位`;
  if (cache.status === 'converting') return `模型 ${model.toUpperCase()} 流式缓存：${cache.progress == null ? '正在生成' : `${cache.progress}%`}`;
  if (cache.status === 'ready') return `模型 ${model.toUpperCase()} 流式缓存：已完成`;
  return `模型 ${model.toUpperCase()} 流式缓存：生成失败`;
};
async function retryCache(item: HistoryItem, model: ModelId): Promise<void> {
  busyId.value = item.session_id;
  try { await requestStreamCache(item.session_id, model); await load(); }
  catch (reason) { error.value = `重新生成失败：${String(reason)}`; }
  finally { busyId.value = ''; }
}

onMounted(load);
</script>

<template>
  <section class="history-surface">
    <header class="section-heading">
      <div><h2>历史任务</h2><p>按最近更新时间倒序排列</p></div>
      <button class="icon-button" type="button" :disabled="loading" @click="load">刷新</button>
    </header>
    <p v-if="error" class="inline-alert error">{{ error }}</p>
    <p v-if="loading && !items.length" class="empty-state">正在读取历史任务……</p>
    <p v-else-if="!items.length" class="empty-state">上传模型并进入工作台后，任务会显示在这里。</p>
    <div v-else class="history-table">
      <article v-for="item in items" :key="item.session_id" class="history-row">
        <div class="history-main">
          <div class="history-name"><strong>{{ item.has_registration_result ? (item.recommended_matrix?.name ?? (item.output_direction === 'b_to_a' ? 'T_b_to_a' : 'T_a_to_b')) : '尚未完成精配准' }}</strong><time>{{ formatTime(item.updated_at_unix ?? item.completed_at_unix ?? item.created_at_unix) }}</time></div>
          <p>A：{{ item.models?.a.filename ?? '模型 A' }} · {{ (item.models?.a.format ?? '').toUpperCase() }} · {{ formatBytes(item.models?.a.bytes) }}</p>
          <p>B：{{ item.models?.b.filename ?? '模型 B' }} · {{ (item.models?.b.format ?? '').toUpperCase() }} · {{ formatBytes(item.models?.b.bytes) }}</p>
          <div v-if="item.has_registration_result" class="metric-row"><span>RMS {{ item.metrics?.final_rms?.toFixed(6) ?? '—' }} m</span><span>{{ item.metrics?.final_point_count?.toLocaleString() ?? '—' }} 点</span><span>{{ item.metrics?.elapsed_seconds?.toFixed(2) ?? '—' }} s</span></div>
          <div class="history-cache-statuses">
            <span v-for="model in (['a', 'b'] as const)" v-show="cacheStatusText(item, model)" :key="model" :class="item.stream_caches?.[model]?.status">{{ cacheStatusText(item, model) }}</span>
          </div>
          <small :class="{ muted: !item.source_available }">{{ item.source_available && item.source_expires_at_unix ? `源文件保留至 ${formatTime(item.source_expires_at_unix)}` : '源文件已释放，仅保留精配准结果' }}</small>
        </div>
        <div class="history-actions-modern">
          <button v-if="item.has_registration_result" type="button" :disabled="!item.recommended_matrix?.value" @click="copy(item)">复制矩阵</button>
          <button v-if="item.stream_caches?.a?.available" type="button" :disabled="Boolean(downloadBusy)" @click="download(item, 'a')">{{ downloadLabel(item, 'a') }}</button>
          <button v-if="item.stream_caches?.b?.available" type="button" :disabled="Boolean(downloadBusy)" @click="download(item, 'b')">{{ downloadLabel(item, 'b') }}</button>
          <button v-for="model in (['a', 'b'] as const)" v-show="item.stream_caches?.[model]?.status === 'failed' && item.source_available" :key="`retry-${model}`" type="button" :disabled="busyId === item.session_id" @click="retryCache(item, model)">重新生成 {{ model.toUpperCase() }} 缓存</button>
          <button type="button" class="primary-subtle" :disabled="!item.restartable || busyId === item.session_id" @click="action(item, 'resume')">继续配准</button>
          <button type="button" :disabled="!item.source_available || busyId === item.session_id" @click="action(item, 'retain')">再保留 24 小时</button>
          <button type="button" class="danger-text" :disabled="!item.source_available || busyId === item.session_id" @click="action(item, 'release')">{{ item.source_available ? '释放源文件' : '源文件已释放' }}</button>
        </div>
      </article>
    </div>
  </section>
</template>
