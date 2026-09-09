<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
const props = defineProps<{ values: number[]; disabled: boolean }>();
const emit = defineEmits<{ change: [values: number[]] }>();
const draft = reactive<string[]>([]);
const focused = ref(-1);
watch(() => props.values, values => {
  values.forEach((value, index) => {
    if (focused.value !== index) draft[index] = value.toFixed(3);
  });
}, { immediate: true });
function change(index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  draft[index] = input.value;
  if (input.validity.badInput || draft.some(value => value === '' || !Number.isFinite(Number(value)))) return;
  emit('change', draft.map(Number));
}
</script>

<template>
  <div v-for="(label, row) in ['平移／m', '旋转／°']" :key="row" class="pose-row">
    <span>{{ label }}</span>
    <div class="field-grid">
      <label v-for="(axis, column) in ['X', 'Y', 'Z']" :key="axis" class="axis-input">
        <input type="number" :step="row === 0 ? '0.01' : '0.1'" :value="draft[row * 3 + column]"
          :aria-label="`${row === 0 ? '平移' : '旋转'} ${axis}`" :disabled="disabled"
          @focus="focused = row * 3 + column" @blur="focused = -1; draft[row * 3 + column] = values[row * 3 + column].toFixed(3)"
          @input="change(row * 3 + column, $event)">
        <span>{{ axis }}</span>
      </label>
    </div>
  </div>
</template>
