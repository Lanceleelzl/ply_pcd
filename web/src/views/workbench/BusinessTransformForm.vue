<script setup lang="ts">
import { computed } from 'vue';
import { transformParametersMatrix, type TransformParameters, type XYZ } from '../../coordinate-math';
const props = defineProps<{ model: string; values: Record<keyof TransformParameters, string[]>; disabled: boolean }>();
const emit = defineEmits<{ change: [kind: keyof TransformParameters, index: number, value: string] }>();
const rows = [
  { kind: 'translation', label: '平移／m' },
  { kind: 'rotation_degrees', label: '旋转／°' },
  { kind: 'scale', label: '缩放' },
] as const;
const preview = computed(() => {
  const numbers = (kind: keyof TransformParameters) => props.values[kind].map(value =>
    value.trim() === '' ? (kind === 'scale' ? 1 : 0) : Number(value)) as XYZ;
  const value = { translation: numbers('translation'), rotation_degrees: numbers('rotation_degrees'), scale: numbers('scale') };
  if (Object.values(value).flat().some(number => !Number.isFinite(number))) return '参数必须是有效数字';
  return transformParametersMatrix(value).map(row => row.map(number => number.toFixed(12)).join(' ')).join('\n');
});
function change(kind: keyof TransformParameters, index: number, event: Event) {
  const input = event.target as HTMLInputElement;
  emit('change', kind, index, input.validity.badInput ? 'NaN' : input.value);
}
</script>

<template>
  <div class="business-transform-model">
    <h3>模型 {{ model.toUpperCase() }}</h3>
    <div v-for="row in rows" :key="row.kind" class="transform-row">
      <span>{{ row.label }}</span>
      <label v-for="(axis, index) in ['X', 'Y', 'Z']" :key="axis" class="axis-input">
        <input type="number" step="any" :value="values[row.kind][index]" :disabled="disabled"
          :aria-label="`模型 ${model.toUpperCase()} ${row.label} ${axis}`" @input="change(row.kind, index, $event)">
        <span>{{ axis }}</span>
      </label>
    </div>
    <pre class="matrix" :data-business-matrix="model">{{ preview }}</pre>
  </div>
</template>
