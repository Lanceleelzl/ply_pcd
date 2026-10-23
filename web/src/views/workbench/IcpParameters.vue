<script setup lang="ts">
const props = defineProps<{
  values: Record<string, string>;
  disabled: boolean;
}>();
const emit = defineEmits<{ change: [key: string, value: string] }>();
const fields = [
  { key: 'min_rms_decrease', id: 'min-rms', label: 'RMS 阈值', step: '0.000001' },
  { key: 'sampling_limit', id: 'sampling-limit', label: '采样上限', step: '1000' },
  { key: 'overlap', id: 'overlap', label: '重叠率', step: '0.01', min: '0.2', max: '1' },
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
  <label class="icp-adjust-scale">
    <input type="checkbox" :checked="props.values.adjust_scale === 'true'" :disabled="disabled"
      @change="emit('change', 'adjust_scale', String(($event.target as HTMLInputElement).checked))">
    ICP 调整比例
  </label>
  <p class="step-hint">开启后，以粗配准比例为初值估计等比修正；只有残差明显改善且比例变化达到可信幅度时才采用。初始比例为 1 时，小于约 2% 的修正保持精确的 1。</p>
  <p class="step-hint">重叠率是预计可匹配的移动点比例（0.2～1）。设置计算范围后，以范围内分别筛出的移动、固定点为参照；此参数裁剪范围内的移动点对应。设得过低可能错配，请核对交叉区域。</p>
</template>
