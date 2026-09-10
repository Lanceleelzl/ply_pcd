<script setup lang="ts">
import type { ModelId } from '../../api/contracts';
import type { TransformParameters } from '../../coordinate-math';
import BusinessTransformForm from './BusinessTransformForm.vue';
defineProps<{
  drafts: Record<ModelId, Record<keyof TransformParameters, string[]>>;
  disabled: boolean; saving: boolean; message: string;
}>();
const emit = defineEmits<{
  change: [model: ModelId, kind: keyof TransformParameters, index: number, value: string];
  reset: []; apply: [];
}>();
const models: ModelId[] = ['a', 'b'];
</script>

<template>
  <details class="business-transform-editor">
    <summary>业务场景矩阵</summary>
    <p class="business-transform-note">文件坐标 → 业务坐标；应用后需重新配准。</p>
    <div v-for="model in models" :id="`business-form-${model}`" :key="model">
      <BusinessTransformForm :model="model" :values="drafts[model]" :disabled="disabled || saving"
        @change="(kind, index, value) => emit('change', model, kind, index, value)" />
    </div>
    <div class="business-transform-actions">
      <button id="save-business-transforms" :disabled="disabled || saving" @click="emit('apply')">{{ saving ? '正在应用…' : '应用场景矩阵' }}</button>
      <button id="reset-business-transforms" :disabled="disabled || saving" @click="emit('reset')">恢复默认</button>
    </div>
    <p id="business-transform-status" class="business-transform-note" role="status">{{ message }}</p>
  </details>
</template>
