<script setup lang="ts">
import { useRouter } from 'vue-router';
import ModelUploadCard from '../components/home/ModelUploadCard.vue';
import HistoryPanel from '../components/home/HistoryPanel.vue';
import { useRegistrationDraftStore } from '../stores/registration-draft-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import ModuleTopbar from '../components/ModuleTopbar.vue';

const router = useRouter();
function goBack(): void {
  if (router.options.history.state.back) router.back();
  else void router.push('/');
}
const workspace = useWorkspaceStore();
const draft = useRegistrationDraftStore();
async function openWorkspace(sessionId: string): Promise<void> {
  await router.push({ name: 'registration', params: { sessionId } });
}

async function submit(): Promise<void> {
  const sessionId = await draft.submit(workspace.workspaceId);
  if (sessionId) {
    await openWorkspace(sessionId);
  }
}
</script>

<template>
  <main class="home-app-shell">
    <ModuleTopbar title="视界转换" mark="R"><template #actions><button type="button" @click="goBack">← 返回上一页</button></template></ModuleTopbar>
    <div class="home-content">
      <section class="hero-copy">
        <h1>建立两个数据世界之间的矩阵转换关系</h1>
        <p>单文件支持 <code>PLY、PCD、LAS、LAZ、SOG、SPZ</code>；多文件数据集支持 <code>Streamed SOG（LOD 流式数据）、LCC、LCC2</code>，请选择完整目录或 ZIP。上传后系统会自动准备配准数据。</p>
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
