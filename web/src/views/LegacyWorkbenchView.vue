<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

const props = defineProps<{ sessionId: string; apiVersion: 'v2' }>();
const router = useRouter();
const host = ref<HTMLDivElement>();
const loadError = ref('');
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
      lifecycle.signal,
      () => { void router.push({ name: 'home' }); },
    );
    if (lifecycle.signal.aborted) cleanup();
    else dispose = cleanup;
  } catch (error) {
    if (!lifecycle.signal.aborted && host.value) {
      host.value.replaceChildren();
      loadError.value = error instanceof Error ? error.message : String(error);
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
  <main v-if="loadError" class="loading" role="alert">
    <h2>配准工作台加载失败</h2>
    <p>{{ loadError }}</p>
    <button @click="router.push({ name: 'home' })">返回首页</button>
  </main>
  <div ref="host" class="legacy-workbench-host" />
</template>
