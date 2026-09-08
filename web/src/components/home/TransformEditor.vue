<script setup lang="ts">
import { computed } from 'vue';
import { transformParametersMatrix, type TransformParameters } from '../../coordinate-math';

const props = defineProps<{ model: 'a' | 'b'; modelValue: TransformParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: TransformParameters] }>();
const axes = ['X', 'Y', 'Z'] as const;
const rows = [
  { key: 'translation' as const, label: '平移', unit: 'm' },
  { key: 'rotation_degrees' as const, label: '旋转', unit: '°' },
  { key: 'scale' as const, label: '缩放', unit: '' },
];
const matrix = computed(() => transformParametersMatrix(props.modelValue));

function update(key: keyof TransformParameters, index: number, raw: string): void {
  const fallback = key === 'scale' ? 1 : 0;
  const value = raw.trim() === '' ? fallback : Number(raw);
  const next = { ...props.modelValue, [key]: [...props.modelValue[key]] } as TransformParameters;
  next[key][index] = value;
  emit('update:modelValue', next);
}
</script>

<template>
  <details class="transform-disclosure">
    <summary>业务坐标预变换</summary>
    <p>文件坐标 → 业务坐标，默认不转换。</p>
    <div v-for="row in rows" :key="row.key" class="transform-field-row">
      <span>{{ row.label }}<small v-if="row.unit">／{{ row.unit }}</small></span>
      <label v-for="(axis, index) in axes" :key="axis" class="axis-field">
        <input
          type="number"
          step="any"
          :aria-label="`模型 ${model.toUpperCase()} ${row.label} ${axis}`"
          :value="modelValue[row.key][index]"
          @input="update(row.key, index, ($event.target as HTMLInputElement).value)"
        >
        <span>{{ axis }}</span>
      </label>
    </div>
    <div class="matrix-preview">
      <span>转换矩阵</span>
      <pre>{{ matrix.map(row => row.map(value => value.toFixed(6)).join('  ')).join('\n') }}</pre>
    </div>
  </details>
</template>
