<script setup lang="ts">
import type { AxisRangeState, RangeAxis, RangeSide } from '../../engine/modules/axis-range';
const props = defineProps<{ prefix: string; state: AxisRangeState }>();
const emit = defineEmits<{ boundary: [axis: RangeAxis, side: RangeSide, value: number]; enabled: [axis: RangeAxis, side: RangeSide, value: boolean] }>();
const axes: RangeAxis[] = ['x', 'y', 'z'];
const sides: RangeSide[] = ['min', 'max'];
function change(axis: RangeAxis, side: RangeSide, event: Event, previous: number) {
  const input = event.target as HTMLInputElement;
  if (input.value.trim() === '' || !Number.isFinite(input.valueAsNumber)) { input.value = previous.toFixed(3); return; }
  emit('boundary', axis, side, input.valueAsNumber);
  input.value = props.state[axis][side].toFixed(3);
}
</script>

<template>
  <div class="axis-clipping-grid">
    <template v-for="axis in axes" :key="axis">
      <strong>{{ axis.toUpperCase() }}</strong>
      <template v-for="side in sides" :key="side">
        <label><input :id="`${prefix}-${axis}-${side}-enabled`" type="checkbox" :checked="state[axis][`${side}Enabled`]"
          @change="emit('enabled', axis, side, ($event.target as HTMLInputElement).checked)">{{ side === 'min' ? '最小' : '最大' }}</label>
        <input :id="`${prefix}-${axis}-${side}`" type="number" step="0.01" :value="state[axis][side].toFixed(3)"
          :aria-label="`${axis.toUpperCase()} ${side === 'min' ? '最小' : '最大'}范围`"
          @change="change(axis, side, $event, state[axis][side])">
      </template>
    </template>
  </div>
</template>
