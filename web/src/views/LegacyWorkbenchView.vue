<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { WorkbenchContent, type WorkbenchLayoutOptions } from './workbench/mount-workbench-layout';
import type { DatasetInfo, ModelId, RegistrationSession } from '../api/contracts';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useBackgroundCacheStore } from '../stores/background-cache-store';
import { useRegistrationDraftStore } from '../stores/registration-draft-store';

const props = defineProps<{ sessionId: string; apiVersion: 'v2' }>();
const router = useRouter();
const workspace = useWorkspaceStore();
const backgroundTasks = useBackgroundCacheStore();
const draft = useRegistrationDraftStore();
const host = ref<HTMLDivElement>();
const loadError = ref('');
const loadingStatus = ref('queued');
const preparingSession = ref<RegistrationSession | null>(null);
const layout = shallowRef<WorkbenchLayoutOptions | null>(null);
const lifecycle = new AbortController();
let dispose: (() => void) | undefined;

onMounted(async () => {
  if (!host.value) return;
  try {
    const module = await import('../pages/generic-registration');
    if (lifecycle.signal.aborted || !host.value) return;
    const cleanup = await module.renderGenericRegistration(
      host.value,
      props.sessionId,
      {
        signal: lifecycle.signal,
        navigateHome: () => { draft.reset(); void router.push({ name: 'home' }); },
        onStatus: (status, session) => {
          loadingStatus.value = status;
          if (!session) return;
          preparingSession.value = session;
          const inputs = session.inputs;
          if (inputs?.model_a_dataset?.gaussian_cache_requested
            || inputs?.model_b_dataset?.gaussian_cache_requested) {
            backgroundTasks.track(props.sessionId, workspace.workspaceId, {
              a: inputs.model_a_original_filename,
              b: inputs.model_b_original_filename,
            });
          }
        },
        mountLayout: async options => {
          lifecycle.signal.throwIfAborted();
          layout.value = options;
          await nextTick();
          lifecycle.signal.throwIfAborted();
        },
      },
    );
    if (lifecycle.signal.aborted) cleanup();
    else dispose = cleanup;
  } catch (error) {
    if (!lifecycle.signal.aborted && host.value) {
      layout.value = null;
      loadError.value = error instanceof Error ? error.message : String(error);
    }
  }
});

onBeforeUnmount(() => {
  lifecycle.abort();
  dispose?.();
});
const stageLabels: Record<string, string> = {
  queued: '等待处理', preparing_compute: '准备计算数据', generating_preview: '生成点云预览',
  ready: '计算数据已就绪', failed: '准备失败',
};
function datasetFor(session: RegistrationSession | null, model: ModelId): DatasetInfo | undefined {
  return session?.inputs?.[`model_${model}_dataset`];
}
function progressFor(session: RegistrationSession | null, model: ModelId): number {
  return Math.max(0, Math.min(100, datasetFor(session, model)?.xyz_progress ?? 5));
}
function stageFor(session: RegistrationSession | null, model: ModelId): string {
  return stageLabels[datasetFor(session, model)?.xyz_stage ?? 'queued'] ?? '正在准备数据';
}
</script>

<template>
  <main v-if="loadError" class="loading" role="alert">
    <h2>配准工作台加载失败</h2>
    <p>{{ loadError }}</p>
    <button @click="router.push({ name: 'home' })">返回首页</button>
  </main>
  <main v-else-if="!layout" class="loading" role="status">
    <section class="preparation-screen">
      <header><h2>准备数据</h2><p>两个模型的计算数据就绪后进入工作台；可选高斯资源将在后台继续转换。</p></header>
      <div class="preparation-models">
        <article v-for="model in (['a', 'b'] as const)" :key="model" class="preparation-model">
          <h3>模型 {{ model.toUpperCase() }}</h3>
          <div class="preparation-ring" :style="{ '--progress': `${progressFor(preparingSession, model) * 3.6}deg` }">
            <div><strong>{{ progressFor(preparingSession, model) }}%</strong></div>
          </div>
          <strong>{{ stageFor(preparingSession, model) }}</strong>
          <small>{{ datasetFor(preparingSession, model)?.format?.toUpperCase() ?? '正在识别格式' }}</small>
        </article>
      </div>
      <p class="preparation-overall">{{ loadingStatus === 'queued' ? '任务已排队' : '正在准备 A／B 模型' }}</p>
    </section>
  </main>
  <div v-show="layout !== null" ref="host" class="legacy-workbench-host">
    <WorkbenchContent v-if="layout" :options="layout" />
  </div>
</template>
