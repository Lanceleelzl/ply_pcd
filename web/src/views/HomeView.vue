<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { createSession } from '../api/registration-api';
import type { ModelId, OutputDirection } from '../api/contracts';
import ModelUploadCard from '../components/home/ModelUploadCard.vue';
import HistoryPanel from '../components/home/HistoryPanel.vue';
import type { TransformParameters } from '../coordinate-math';
import { useWorkspaceStore } from '../stores/workspace-store';

const router = useRouter();
const workspace = useWorkspaceStore();
const defaultTransform = (): TransformParameters => ({ translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] });
const files = reactive<Record<ModelId, File | undefined>>({ a: undefined, b: undefined });
const transforms = reactive<Record<ModelId, TransformParameters>>({ a: defaultTransform(), b: defaultTransform() });
const outputDirection = ref<OutputDirection>('a_to_b');
const movingModel = ref<'auto' | ModelId>('auto');
const submitting = ref(false);
const status = ref('');

function validateTransform(transform: TransformParameters): void {
  const values = [...transform.translation, ...transform.rotation_degrees, ...transform.scale];
  if (values.some(value => !Number.isFinite(value))) throw new Error('预变换参数必须是有效数字');
  if (transform.scale.some(value => value <= 0)) throw new Error('缩放必须大于 0');
}

async function openWorkspace(sessionId: string): Promise<void> {
  await router.push({ name: 'registration', params: { sessionId } });
}

async function submit(): Promise<void> {
  if (!files.a || !files.b) { status.value = '请先选择模型 A 和模型 B。'; return; }
  submitting.value = true;
  try {
    validateTransform(transforms.a);
    validateTransform(transforms.b);
    status.value = '正在上传：0%';
    const sessionId = await createSession({
      modelA: files.a,
      modelB: files.b,
      modelATransform: transforms.a,
      modelBTransform: transforms.b,
      outputDirection: outputDirection.value,
      movingModel: movingModel.value,
      workspaceId: workspace.workspaceId,
    }, percent => { status.value = `正在上传：${percent}%`; });
    status.value = '上传完成，正在生成点云预览……';
    await openWorkspace(sessionId);
  } catch (reason) {
    status.value = `创建失败：${String(reason)}`;
    submitting.value = false;
  }
}
</script>

<template>
  <main class="home-app-shell">
    <header class="app-topbar">
      <div class="brand-mark"><span class="brand-symbol">R</span><div><strong>Registration Studio</strong><small>点云坐标配准工作台</small></div></div>
      <nav><a href="/docs" target="_blank" rel="noreferrer">API 文档</a><span class="service-chip"><i />本地服务</span></nav>
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
            <ModelUploadCard model="a" :file="files.a" :transform="transforms.a" @update:file="files.a = $event" @update:transform="transforms.a = $event" />
            <div class="model-connector"><span>↔</span></div>
            <ModelUploadCard model="b" :file="files.b" :transform="transforms.b" @update:file="files.b = $event" @update:transform="transforms.b = $event" />
          </div>
          <div class="task-settings">
            <label><span>最终业务矩阵方向</span><select v-model="outputDirection"><option value="a_to_b">模型 A → 模型 B</option><option value="b_to_a">模型 B → 模型 A</option></select><small>决定主要展示和复制的业务矩阵</small></label>
            <label><span>ICP 移动模型</span><select v-model="movingModel"><option value="auto">自动推荐</option><option value="a">移动模型 A</option><option value="b">移动模型 B</option></select><small>只影响计算角色，不改变输出方向</small></label>
            <button class="primary-action" type="submit" :disabled="submitting"><span>{{ submitting ? '正在创建任务' : '进入配准工作台' }}</span><b>→</b></button>
          </div>
          <p v-if="status" class="submit-status" role="status">{{ status }}</p>
        </form>
      </section>
      <HistoryPanel :workspace-id="workspace.workspaceId" @resume="openWorkspace" />
    </div>
  </main>
</template>
