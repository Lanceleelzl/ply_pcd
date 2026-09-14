<script setup lang="ts">
import { useRouter } from 'vue-router';
import ModelUploadCard from '../components/home/ModelUploadCard.vue';
import HistoryPanel from '../components/home/HistoryPanel.vue';
import { useRegistrationDraftStore } from '../stores/registration-draft-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { getApiKey, setApiKey } from '../api/api-auth';
import { ref } from 'vue';

const router = useRouter();
const workspace = useWorkspaceStore();
const draft = useRegistrationDraftStore();
const apiKey = ref(getApiKey());

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
      <div class="brand-mark"><span class="brand-symbol">R</span><div><strong>Registration Studio</strong><small>点云坐标配准工作台</small></div></div>
      <nav><label class="api-key-field"><span>API Key</span><input v-model="apiKey" type="password" autocomplete="off" placeholder="未启用时留空" @change="setApiKey(apiKey)" /></label><a href="/docs" target="_blank" rel="noreferrer">API 文档</a><span class="service-chip"><i />本地服务</span></nav>
    </header>
    <div class="home-content">
      <section class="hero-copy">
        <span class="eyebrow">POINT CLOUD REGISTRATION</span>
        <h1>建立两个点云世界之间<br>可靠的坐标关系</h1>
        <p>支持 PLY、PCD、LAS 与 LAZ。业务矩阵方向和 ICP 移动模型独立配置，完整保留双精度坐标。</p>
      </section>
      <section class="task-composer">
        <header class="section-heading"><div><span class="eyebrow">NEW TASK</span><h2>新建配准任务</h2><p>选择两个模型，并确认坐标与配准角色。</p></div><span class="step-chip">01 · 数据</span></header>
        <form @submit.prevent="submit">
          <div class="model-grid">
            <ModelUploadCard model="a" :file="draft.files.a" :transform="draft.transforms.a" @update:file="draft.files.a = $event" @update:transform="draft.transforms.a = $event" />
            <div class="model-connector"><span>↔</span></div>
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
