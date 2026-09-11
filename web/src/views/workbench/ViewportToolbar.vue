<script setup lang="ts">
import type { RegistrationSession } from '../../api/contracts';
import GaussianControls from './GaussianControls.vue';
import type { GaussianViewState } from './gaussian-view-state';
import type { ToolbarCommand, ToolbarState } from './toolbar-state';
defineProps<{ session: RegistrationSession; gaussian: GaussianViewState; state: ToolbarState }>();
const emit = defineEmits<{ command: [command: ToolbarCommand] }>();
const models = ['a', 'b'] as const;
</script>

<template>
  <div class="viewport-toolbar toolbar">
    <div class="viewport-tool-group" role="group" aria-label="配准与视图">
      <span class="tool-group-label">配准与视图</span>
      <button id="reset" :disabled="state.locked" title="清除当前移动模型的平移和旋转，恢复到模型刚加载时的位置" @click="emit('command', { type: 'reset' })">重置</button>
      <button id="fit" @click="emit('command', { type: 'fit' })">适应全部</button>
      <button id="clipping-toggle" :class="{ active: state.clippingActive }" :aria-pressed="state.clippingActive" :title="state.clippingTitle" @click="emit('command', { type: 'clipping' })">剖切</button>
    </div>
    <div class="viewport-tool-group" role="group" aria-label="模型显隐">
      <span class="tool-group-label">模型显隐</span>
      <button v-for="model in models" :id="`toggle-model-${model}`" :key="model" :class="{ active: state.visible[model] }" :aria-pressed="state.visible[model]"
        @click="emit('command', { type: 'visibility', model })">{{ model.toUpperCase() }}：{{ state.visible[model] ? '显示' : '隐藏' }}</button>
    </div>
    <GaussianControls :session="session" :state="gaussian" @toggle="emit('command', { type: 'gaussian', model: $event })" />
    <div class="viewport-tool-group" role="group" aria-label="平面工具">
      <span class="tool-group-label">平面工具</span>
      <button id="origin-planes-toggle" :class="{ active: state.originPlanesActive }" :aria-pressed="state.originPlanesActive" @click="emit('command', { type: 'origin-planes' })">原点平面</button>
    </div>
    <div class="viewport-tool-group" role="group" aria-label="坐标工具">
      <span class="tool-group-label">坐标工具</span>
      <button id="coordinate-query" :disabled="!state.queryAvailable" :class="{ active: state.queryActive }" :aria-pressed="state.queryActive" :title="state.queryTitle" @click="emit('command', { type: 'query' })">坐标查询</button>
      <button v-for="model in models" :id="`origin-${model}`" :key="model" :class="{ active: state.axes[model] }" :aria-pressed="state.axes[model]"
        @click="emit('command', { type: 'origin-axes', model })">{{ model.toUpperCase() }} 原点／轴</button>
    </div>
  </div>
</template>
