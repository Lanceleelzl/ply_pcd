<script setup lang="ts">
import CoordinateFields from './CoordinateFields.vue';
import type { CoordinatePanelState } from '../../engine/tools/coordinate-query-state';
import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';
defineProps<{ state: CoordinatePanelState }>();
const emit = defineEmits<{
  action: [action: string]; source: [model: ModelId]; change: [values: XYZ]; invalid: [];
}>();
const models: ModelId[] = ['a', 'b'];
const empty: XYZ = [0, 0, 0];
</script>

<template>
  <div class="coordinate-title"><strong>坐标查询</strong><button @click="emit('action', 'close')">返回配准编辑</button></div>
  <button @click="emit('action', 'state')">{{ state.original ? '当前位置：原始位置｜切换配准位置' : '当前位置：配准位置｜切换原始位置' }}</button>
  <div class="coordinate-actions coordinate-point-tools" role="group" aria-label="选择编辑点与取点">
    <button v-for="model in models" :key="model" :class="{ active: state.source === model }"
      :aria-pressed="state.source === model" @click="emit('source', model)">移动 {{ model.toUpperCase() }} 点</button>
    <button :disabled="state.clippingActive" @click="emit('action', 'pick')">场景取点</button>
    <button :disabled="!state.points" @click="emit('action', 'clear')">清除点</button>
  </div>
  <div class="coordinate-fields">
    <fieldset v-for="model in models" :key="model">
      <legend>{{ model.toUpperCase() }} 业务坐标（{{ model === 'a' ? '红色' : '蓝色' }}）</legend>
      <CoordinateFields :model="model" :source="state.source" :values="state.points?.[model] ?? empty"
        @change="emit('change', $event)" @invalid="emit('invalid')" />
      <button :disabled="!state.points" @click="emit('action', `copy-${model}`)">复制 {{ model.toUpperCase() }} 坐标</button>
    </fieldset>
  </div>
  <button :disabled="!state.points" @click="emit('action', 'copy-pair')">复制坐标对</button>
  <p class="coordinate-message" :title="`转换依据：ICP ${state.jobId}`" role="status">{{ state.message }}</p>
  <small>坐标属于各模型业务坐标系；切换位置仅改变显示。取点使用轻量中心点预览，Gaussian 视觉表面可能与中心点不同。</small>
</template>
