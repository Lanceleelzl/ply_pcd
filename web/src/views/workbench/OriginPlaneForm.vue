<script setup lang="ts">
import type { ModelId } from '../../api/contracts';
import type { OriginPlane, OriginPlaneState } from '../../origin-plane-state';
defineProps<{ state: OriginPlaneState }>();
const emit = defineEmits<{
  visible: [model: ModelId, plane: OriginPlane, value: boolean];
  side: [model: ModelId, plane: OriginPlane, value: number];
  close: [];
  clear: [];
}>();
const models: ModelId[] = ['a', 'b'];
const planes = [
  { id: 'xoy', normal: 'Z' }, { id: 'xoz', normal: 'Y' }, { id: 'yoz', normal: 'X' },
] as const;
</script>

<template>
  <div class="origin-planes-title"><strong>模型原点平面</strong><button title="关闭面板" @click="emit('close')">×</button></div>
  <p>平面经过各自模型原点并跟随模型姿态。剖切只作用于对应模型。</p>
  <fieldset v-for="model in models" :key="model">
    <legend>模型 {{ model.toUpperCase() }}</legend>
    <div v-for="plane in planes" :key="plane.id" class="origin-plane-row">
      <label><input type="checkbox" :checked="state[model][plane.id].visible"
        :aria-label="`模型 ${model.toUpperCase()} 显示 ${plane.id.toUpperCase()}`"
        @change="emit('visible', model, plane.id, ($event.target as HTMLInputElement).checked)">显示 {{ plane.id.toUpperCase() }}</label>
      <select :aria-label="`模型 ${model.toUpperCase()} ${plane.id.toUpperCase()} 剖切`"
        :value="state[model][plane.id].side"
        @change="emit('side', model, plane.id, Number(($event.target as HTMLSelectElement).value))">
        <option :value="0">不剖切</option><option :value="1">保留 +{{ plane.normal }}</option><option :value="-1">保留 −{{ plane.normal }}</option>
      </select>
    </div>
  </fieldset>
  <button class="full-width" @click="emit('clear')">全部关闭</button>
</template>
