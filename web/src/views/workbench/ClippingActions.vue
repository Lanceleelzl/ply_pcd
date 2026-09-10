<script setup lang="ts">
import type { ModelId } from '../../api/contracts';
import type { ClippingMode } from '../../engine/modules/ClippingStateController';
defineProps<{ model: 'joint' | ModelId; mode: ClippingMode }>();
const emit = defineEmits<{ reset: []; fit: [models: ModelId[]]; clear: [] }>();
</script>

<template>
  <button v-if="mode === 'axis'" :id="model === 'joint' ? 'axis-reset' : undefined" @click="emit('reset')">
    {{ model === 'joint' ? '重置轴向范围' : `重置 ${model.toUpperCase()} 范围` }}
  </button>
  <div v-if="mode === 'box'" class="clip-tool-row">
    <template v-if="model === 'joint'">
      <button id="clip-fit-a" @click="emit('fit', ['a'])">适配 A</button>
      <button id="clip-fit-b" @click="emit('fit', ['b'])">适配 B</button>
      <button id="clip-fit-all" @click="emit('fit', ['a', 'b'])">适配全部</button>
    </template>
    <button v-else @click="emit('fit', [model])">适配模型 {{ model.toUpperCase() }}</button>
  </div>
  <button :id="model === 'joint' ? 'clipping-clear' : undefined" class="full-width" @click="emit('clear')">
    {{ model === 'joint' ? '清除联合剖切' : `清除模型 ${model.toUpperCase()} 剖切` }}
  </button>
</template>
