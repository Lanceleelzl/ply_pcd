<script setup lang="ts">
import type { ModelId } from '../../api/contracts';
import type { ClippingControlMode } from '../../engine/modules/ClippingStateController';
defineProps<{ controlMode: ClippingControlMode; editor: ModelId }>();
const emit = defineEmits<{ control: [mode: ClippingControlMode]; editor: [model: ModelId] }>();
const modes = [{ value: 'joint', label: '联合剖切' }, { value: 'independent', label: '独立剖切' }] as const;
const models: ModelId[] = ['a', 'b'];
</script>

<template>
  <div class="clipping-control-switch" role="group" aria-label="剖切模式">
    <button v-for="mode in modes" :key="mode.value" :class="{ active: controlMode === mode.value }"
      :aria-pressed="controlMode === mode.value" @click="emit('control', mode.value)">{{ mode.label }}</button>
  </div>
  <div v-if="controlMode === 'independent'" class="independent-editor-switch" role="group" aria-label="当前编辑模型">
    <button v-for="model in models" :key="model" :class="{ active: editor === model }"
      :aria-pressed="editor === model" @click="emit('editor', model)">编辑 {{ model.toUpperCase() }}</button>
  </div>
</template>
