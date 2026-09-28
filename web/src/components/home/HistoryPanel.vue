<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { listHistory, runSessionAction } from '../../api/registration-api';
import type { HistoryItem } from '../../api/contracts';

const props = defineProps<{ workspaceId: string }>();
const emit = defineEmits<{ resume: [sessionId: string] }>();
const items = ref<HistoryItem[]>([]);
const loading = ref(false);
const error = ref('');
const busyId = ref('');

const matrixText = (matrix?: number[][]) => matrix?.map(row => row.map(value => Number(value).toFixed(12)).join(' ')).join('\n') ?? '';
const formatTime = (unix?: number) => unix ? new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
const formatBytes = (bytes?: number) => bytes === undefined ? '未知大小' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

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
          <small :class="{ muted: !item.source_available }">{{ item.source_available && item.source_expires_at_unix ? `源文件保留至 ${formatTime(item.source_expires_at_unix)}` : '源文件已释放，仅保留精配准结果' }}</small>
        </div>
        <div class="history-actions-modern">
          <button v-if="item.has_registration_result" type="button" :disabled="!item.recommended_matrix?.value" @click="copy(item)">复制矩阵</button>
          <button type="button" class="primary-subtle" :disabled="!item.restartable || busyId === item.session_id" @click="action(item, 'resume')">继续配准</button>
          <button type="button" :disabled="!item.source_available || busyId === item.session_id" @click="action(item, 'retain')">再保留 24 小时</button>
          <button type="button" class="danger-text" :disabled="!item.source_available || busyId === item.session_id" @click="action(item, 'release')">{{ item.source_available ? '释放源文件' : '源文件已释放' }}</button>
        </div>
      </article>
    </div>
  </section>
</template>
