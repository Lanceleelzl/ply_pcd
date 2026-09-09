<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

const props = defineProps<{ sessionId: string; apiVersion: 'v2' }>();
const router = useRouter();
const host = ref<HTMLDivElement>();
const lifecycle = new AbortController();
let dispose: (() => void) | undefined;

onMounted(async () => {
  if (!host.value) return;
  try {
    const module = await import('../pages/generic-registration');
    const cleanup = await module.renderGenericRegistration(
      host.value,
      props.sessionId,
      lifecycle.signal,
      () => { void router.push({ name: 'home' }); },
    );
    if (lifecycle.signal.aborted) cleanup();
    else dispose = cleanup;
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
