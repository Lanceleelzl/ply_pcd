<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from 'vue';
import type { Matrix4, RegistrationResult } from '../../api/contracts';

const props = defineProps<{ result: RegistrationResult | null; direction: string }>();
const text = (matrix: Matrix4) => matrix.map(row => row.map(value => value.toFixed(12)).join(' ')).join('\n');
const groups = computed(() => {
  const result = props.result;
  if (!result) return [];
  const forward = props.direction === 'a_to_b';
  const source = forward ? 'a' : 'b';
  const target = forward ? 'b' : 'a';
  const items = [{
    key: 'business', label: '业务场景转换矩阵', reverseLabel: '反向业务场景矩阵',
    title: `业务场景转换矩阵：模型 ${source.toUpperCase()} → 模型 ${target.toUpperCase()}（含预设）`,
    formula: `p_business_${target} = M_business_${source}_to_${target} × p_business_${source}`,
    forward: text(forward ? result.a_to_b : result.b_to_a),
    inverse: text(forward ? result.b_to_a : result.a_to_b),
  }];
  const file = forward ? result.file_a_to_b : result.file_b_to_a;
  const inverse = forward ? result.file_b_to_a : result.file_a_to_b;
  if (file && inverse) items.push({
    key: 'file', label: '原始模型坐标转换矩阵', reverseLabel: '反向原始模型矩阵',
    title: `原始模型坐标转换矩阵：模型 ${source.toUpperCase()} → 模型 ${target.toUpperCase()}`,
    formula: `p_file_${target} = M_file_${source}_to_${target} × p_file_${source}`,
    forward: text(file), inverse: text(inverse),
  });
  return items;
});
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
