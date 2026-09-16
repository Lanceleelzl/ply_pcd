<script setup lang="ts">
import { useRouter } from 'vue-router';
import ModelUploadCard from '../components/home/ModelUploadCard.vue';
import HistoryPanel from '../components/home/HistoryPanel.vue';
import { useRegistrationDraftStore } from '../stores/registration-draft-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { getApiKey, setApiKey } from '../api/api-auth';
import { ref, onMounted, onUnmounted } from 'vue';

const router = useRouter();
const workspace = useWorkspaceStore();
const draft = useRegistrationDraftStore();
const apiKey = ref(getApiKey());
const serviceState = ref('检测中');
let healthTimer: ReturnType<typeof setInterval> | undefined;
const healthAbort = new AbortController();
async function checkHealth() {
  try { const response = await fetch('/health', { signal: AbortSignal.any([healthAbort.signal, AbortSignal.timeout(5000)]) }); serviceState.value = response.ok ? '服务正常' : '服务异常'; }
  catch { if (!healthAbort.signal.aborted) serviceState.value = '连接失败'; }
}
onMounted(() => { void checkHealth(); healthTimer = setInterval(checkHealth, 30000); });
onUnmounted(() => { clearInterval(healthTimer); healthAbort.abort(); });

async function openWorkspace(sessionId: string): Promise<void> {
  await router.push({ name: 'registration', params: { sessionId } });
}

async function submit(): Promise<void> {
  const sessionId = await draft.submit(workspace.workspaceId);
  if (sessionId) await openWorkspace(sessionId);
}
</script>

<template>
  <main class="home-app-shell">
    <header class="app-topbar">
      <div class="brand-mark"><span class="brand-symbol">R</span><div><strong>点云坐标配准</strong><small>Registration Studio</small></div></div>
      <nav><a href="/docs" target="_blank" rel="noreferrer">API 文档 ↗</a><span class="service-chip" :class="{ offline: serviceState !== '服务正常' }"><i />{{ serviceState }}</span><details class="access-settings"><summary>访问设置</summary><div class="access-popover"><label class="api-key-field"><span>API Key</span><input v-model="apiKey" type="password" autocomplete="off" placeholder="未启用鉴权时留空" @change="setApiKey(apiKey)" /></label><p>用于本服务的访问鉴权与数据隔离。</p></div></details></nav>
    </header>
    <div class="home-content">
      <section class="hero-copy">
        <h1>建立两个世界之间的转换关系</h1>
        <p>支持常见点云和高斯模型文件，也支持包含多个文件的数据集。上传后系统会自动准备配准所需的数据。</p>
      </section>
      <section class="task-composer">
        <header class="section-heading"><div><h2>新建配准任务</h2></div></header>
        <form @submit.prevent="submit">
          <div class="model-grid">
            <ModelUploadCard model="a" :file="draft.files.a" :transform="draft.transforms.a" @update:file="draft.files.a = $event" @update:transform="draft.transforms.a = $event" />
            <ModelUploadCard model="b" :file="draft.files.b" :transform="draft.transforms.b" @update:file="draft.files.b = $event" @update:transform="draft.transforms.b = $event" />
          </div>
          <div class="task-settings">
            <label><span>最终业务矩阵方向</span><select v-model="draft.outputDirection"><option value="a_to_b">模型 A → 模型 B</option><option value="b_to_a">模型 B → 模型 A</option></select><small>决定主要展示和复制的业务矩阵</small></label>
            <label><span>ICP 移动模型</span><select v-model="draft.movingModel"><option value="auto">自动推荐</option><option value="a">移动模型 A</option><option value="b">移动模型 B</option></select><small>只影响计算角色，不改变输出方向</small></label>
            <button class="primary-action" type="submit" :disabled="draft.submitting"><span>{{ draft.submitting ? '正在创建任务' : '进入配准工作台' }}</span><b>→</b></button>
          </div>
          <p v-if="draft.status" class="submit-status" role="status">{{ draft.status }}</p>
        </form>
      </section>
      <HistoryPanel :workspace-id="workspace.workspaceId" @resume="openWorkspace" />
    </div>
  </main>
</template>
