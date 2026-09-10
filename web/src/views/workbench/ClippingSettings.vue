<script setup lang="ts">
import type { ModelId } from '../../api/contracts';
import type { ClippingMode } from '../../engine/modules/ClippingStateController';
const props = defineProps<{ model: 'joint' | ModelId; mode: ClippingMode; helper: boolean; scope: 'both' | ModelId }>();
const emit = defineEmits<{ mode: [mode: ClippingMode]; helper: [visible: boolean]; scope: [scope: 'both' | ModelId] }>();
const modeId = () => props.model === 'joint' ? 'clipping-mode' : `ind-${props.model}-mode`;
</script>

<template>
  <label>剖切方式<select :id="modeId()" :value="mode"
    @change="emit('mode', ($event.target as HTMLSelectElement).value as ClippingMode)">
    <option value="off">关闭</option><option value="axis">坐标轴</option><option value="box">长方体</option>
  </select></label>
  <label v-if="model === 'joint'">作用模型<select id="clipping-scope" :value="scope"
    @change="emit('scope', ($event.target as HTMLSelectElement).value as 'both' | ModelId)">
    <option value="both">模型 A 和 B</option><option value="a">仅模型 A</option><option value="b">仅模型 B</option>
  </select></label>
  <label class="clip-helper-option">
    <input :id="model === 'joint' ? 'clip-helper-visible' : `ind-${model}-helper-visible`" type="checkbox" :checked="helper"
      @change="emit('helper', ($event.target as HTMLInputElement).checked)">
    {{ model === 'joint' ? '显示剖切辅助体与手柄' : `显示 ${model.toUpperCase()} 辅助体` }}
  </label>
</template>
