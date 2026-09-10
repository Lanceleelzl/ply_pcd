<script setup lang="ts">
import type { ModelId } from '../../api/contracts';
import type { ClippingStateController, ClippingMode, ClippingControlMode } from '../../engine/modules/ClippingStateController';
import type { AxisRangeState, RangeAxis, RangeSide } from '../../engine/modules/axis-range';
import ClippingControls from './ClippingControls.vue';
import ClippingSettings from './ClippingSettings.vue';
import AxisRangeForm from './AxisRangeForm.vue';
import ClippingActions from './ClippingActions.vue';
type Target = 'joint' | ModelId;
const props = defineProps<{ state: ClippingStateController; scope: 'both' | ModelId; ranges: Record<Target, AxisRangeState> }>();
const emit = defineEmits<{
  close: []; control: [mode: ClippingControlMode]; editor: [model: ModelId];
  mode: [target: Target, mode: ClippingMode]; helper: [target: Target, visible: boolean]; scope: [scope: 'both' | ModelId];
  boundary: [target: Target, axis: RangeAxis, side: RangeSide, value: number];
  enabled: [target: Target, axis: RangeAxis, side: RangeSide, value: boolean];
  reset: [target: Target]; fit: [target: Target, models: ModelId[]]; clear: [target: Target];
}>();
const targets: Target[] = ['joint', 'a', 'b'];
const mode = (target: Target) => target === 'joint' ? props.state.jointMode : props.state.independentModes[target];
</script>

<template>
  <div class="clipping-title"><strong>显示剖切</strong><button id="clipping-close" title="关闭面板" @click="emit('close')">×</button></div>
  <p>仅影响三维预览，不改变 ICP 输入、RMS 或最终矩阵。</p>
  <ClippingControls :control-mode="state.controlMode" :editor="state.editor" @control="emit('control', $event)" @editor="emit('editor', $event)" />
  <template v-for="target in targets" :key="target">
    <component :is="target === 'joint' ? 'div' : 'fieldset'"
      v-show="target === 'joint' ? state.controlMode === 'joint' : state.controlMode === 'independent'"
      :class="{ 'independent-clip-model': target !== 'joint', 'active-editor': target === state.editor }"
      :data-independent-model="target === 'joint' ? undefined : target">
      <legend v-if="target !== 'joint'">模型 {{ target.toUpperCase() }}</legend>
      <ClippingSettings :model="target" :mode="mode(target)" :scope="scope"
        :helper="target === 'joint' ? state.jointHelperVisible : state.independentHelpers[target]"
        @mode="emit('mode', target, $event)" @helper="emit('helper', target, $event)" @scope="emit('scope', $event)" />
      <div v-show="mode(target) === 'axis'" :id="target === 'joint' ? 'joint-axis-range' : `ind-${target}-axis-range`">
        <AxisRangeForm :prefix="target === 'joint' ? 'clip' : `ind-${target}`" :state="ranges[target]"
          @boundary="(axis, side, value) => emit('boundary', target, axis, side, value)"
          @enabled="(axis, side, value) => emit('enabled', target, axis, side, value)" />
      </div>
      <p v-if="mode(target) === 'box'" class="clip-mode-hint">
        {{ target === 'joint' ? '中心手柄可轴向／平面平移；仅拖动圆环时旋转。六个贴面箭头用于单独调整对应剖切面。' : `选择「编辑 ${target.toUpperCase()}」后可使用中心和六面手柄。` }}
      </p>
      <ClippingActions :model="target" :mode="mode(target)" @reset="emit('reset', target)"
        @fit="emit('fit', target, $event)" @clear="emit('clear', target)" />
    </component>
  </template>
</template>
