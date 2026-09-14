<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from 'vue';
import type { RegistrationResult } from '../../api/contracts';
import { registrationResultGroups } from './registration-result-presentation';

const props = defineProps<{ result: RegistrationResult | null; direction: string }>();
const groups = computed(() => registrationResultGroups(props.result, props.direction));
const feedback = reactive<Record<string, string>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let disposed = false;
async function copy(key: string, value: string) {
  let message: string;
  try { await navigator.clipboard.writeText(value); message = '已复制'; }
  catch { message = '复制失败'; }
  if (disposed) return;
  feedback[key] = message;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { delete feedback[key]; timers.delete(key); }, 1500));
}
onBeforeUnmount(() => {
  disposed = true;
  timers.forEach(timer => clearTimeout(timer));
  timers.clear();
});
</script>

<template>
  <template v-if="result">
    <div v-for="group in groups" :key="group.key" class="result-matrix-group">
      <h3>{{ group.title }}</h3>
      <p class="result-formula">{{ group.formula }}</p>
      <pre class="matrix">{{ group.forward }}</pre>
      <button class="full-width" @click="copy(group.key, group.forward)">{{ feedback[group.key] || `复制${group.label}` }}</button>
      <details>
        <summary>查看{{ group.reverseLabel }}</summary>
        <pre class="matrix">{{ group.inverse }}</pre>
        <button class="full-width" @click="copy(`${group.key}-inverse`, group.inverse)">{{ feedback[`${group.key}-inverse`] || `复制${group.reverseLabel}` }}</button>
      </details>
    </div>
    <div id="result-metrics">RMS：{{ result.metrics.final_rms.toFixed(6) }} m　点数：{{ result.metrics.final_point_count }}　耗时：{{ result.metrics.elapsed_seconds.toFixed(2) }} s</div>
  </template>
</template>
