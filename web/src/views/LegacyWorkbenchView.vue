<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { WorkbenchContent, type WorkbenchLayoutOptions } from './workbench/mount-workbench-layout';

const props = defineProps<{ sessionId: string; apiVersion: 'v2' }>();
const router = useRouter();
const host = ref<HTMLDivElement>();
const loadError = ref('');
const loadingStatus = ref('queued');
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
        navigateHome: () => { void router.push({ name: 'home' }); },
        onStatus: status => { loadingStatus.value = status; },
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
</script>

<template>
  <main v-if="loadError" class="loading" role="alert">
    <h2>配准工作台加载失败</h2>
    <p>{{ loadError }}</p>
    <button @click="router.push({ name: 'home' })">返回首页</button>
  </main>
  <main v-else-if="!layout" class="loading" role="status">
    <h2>正在生成双模型预览</h2><pre>预览状态：{{ loadingStatus }}</pre>
  </main>
  <div v-show="layout !== null" ref="host" class="legacy-workbench-host">
    <WorkbenchContent v-if="layout" :options="layout" />
  </div>
</template>
