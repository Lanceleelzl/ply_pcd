<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
const props = defineProps<{ model: ModelId; source: ModelId; values: XYZ }>();
const emit = defineEmits<{ change: [values: XYZ]; invalid: [] }>();
const draft = reactive(['0', '0', '0']);
watch(() => [props.values, props.source], () => {
  props.values.forEach((value, index) => { draft[index] = String(value); });
}, { immediate: true });
function change(index: number, event: Event) {
  if (props.model !== props.source) return;
  const input = event.target as HTMLInputElement;
  draft[index] = input.validity.badInput ? 'NaN' : input.value;
  if (draft.some(value => value.trim() === '' || !Number.isFinite(Number(value)))) emit('invalid');
  else emit('change', draft.map(Number) as XYZ);
}
</script>

<template>
  <label v-for="(axis, index) in ['X', 'Y', 'Z']" :key="axis" class="axis-input">
    <input :aria-label="`模型 ${model.toUpperCase()} 业务坐标 ${axis}`" type="number" step="0.001"
      :value="draft[index]" :readonly="model !== source" :aria-readonly="model !== source"
      @change="change(index, $event)">
    <span>{{ axis }}</span>
  </label>
</template>
