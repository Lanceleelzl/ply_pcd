<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{ sessionId: string; apiVersion: 'v1' | 'v2' }>();
const host = ref<HTMLDivElement>();
const lifecycle = new AbortController();
let dispose: (() => void) | undefined;

onMounted(async () => {
  if (!host.value) return;
  try {
    if (props.apiVersion === 'v2') {
      const module = await import('../pages/generic-registration');
      const cleanup = await module.renderGenericRegistration(host.value, props.sessionId, lifecycle.signal);
      if (lifecycle.signal.aborted) cleanup();
      else dispose = cleanup;
    } else {
      const module = await import('../pages/manual-registration');
      await module.renderManualRegistration(host.value, props.sessionId);
    }
  } catch (error) {
    if (!lifecycle.signal.aborted && host.value) {
      host.value.innerHTML = `<main class="loading"><p>配准工作台加载失败：${String(error)}</p></main>`;
    }
  }
});

onBeforeUnmount(() => {
  lifecycle.abort();
  dispose?.();
  host.value?.replaceChildren();
});
</script>

<template>
  <div ref="host" class="legacy-workbench-host" />
</template>
