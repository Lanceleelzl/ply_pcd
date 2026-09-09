<script setup lang="ts">
const props = defineProps<{
  values: Record<string, string>;
  disabled: boolean;
}>();
const emit = defineEmits<{ change: [key: string, value: string] }>();
const fields = [
  { key: 'min_rms_decrease', id: 'min-rms', label: 'RMS 阈值', step: '0.000001' },
  { key: 'sampling_limit', id: 'sampling-limit', label: '采样上限', step: '1000' },
  { key: 'overlap', id: 'overlap', label: '重叠率', step: '0.01', min: '0.01', max: '1' },
  { key: 'random_seed', id: 'random-seed', label: '随机种子', step: '1', min: '0' },
];
</script>

<template>
  <div class="icp-grid">
    <label v-for="field in fields" :key="field.key" :for="field.id">
      {{ field.label }}
      <input :id="field.id" type="number" :value="props.values[field.key]"
        :step="field.step" :min="field.min" :max="field.max" :disabled="disabled"
        @input="emit('change', field.key, ($event.target as HTMLInputElement).value)">
    </label>
  </div>
</template>
