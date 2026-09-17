<script setup lang="ts">
import type { ModelId, RegistrationSession } from '../../api/contracts';
import type { GaussianViewState } from './gaussian-view-state';

const props = defineProps<{ session: RegistrationSession; state: GaussianViewState }>();
const emit = defineEmits<{ toggle: [model: ModelId] }>();
const models = ['a', 'b'] as const;
const available = (model: ModelId) => Boolean(props.session[`gaussian_${model}_url`]);
const dataset = (model: ModelId) => props.session.inputs?.[`model_${model}_dataset`];
const pending = (model: ModelId) => dataset(model)?.gaussian_status === 'pending';
const failed = (model: ModelId) => dataset(model)?.gaussian_status === 'failed';
const unsupported = (model: ModelId) => dataset(model)?.gaussian_status === 'not_available';
const title = (model: ModelId) => {
  const state = props.state.models[model];
  if (state.loading) return '正在加载原始 Gaussian…';
  if (pending(model)) return `模型 ${model.toUpperCase()} Gaussian 正在准备`;
  if (failed(model)) return `模型 ${model.toUpperCase()} Gaussian 转换失败；中心点预览和配准仍可使用`;
  if (state.active) return `释放模型 ${model.toUpperCase()} Gaussian 并显示中心点`;
  if (!available(model)) return `模型 ${model.toUpperCase()} 不包含完整 Gaussian 属性`;
  const bytes = props.session.inputs?.[`model_${model}_bytes`];
  const size = bytes ? `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : '大小未知';
  return `加载模型 ${model.toUpperCase()} 原始 Gaussian（${size}）`;
};
</script>

<template>
  <div class="viewport-tool-group" role="group" aria-label="高斯显示">
    <span class="tool-group-label">高斯显示</span>
    <button v-for="model in models" :id="`gaussian-model-${model}`" :key="model" class="gaussian-toggle"
      :class="{ available: available(model), active: state.models[model].active }"
      :aria-pressed="state.models[model].active" :disabled="!available(model) || pending(model) || state.models[model].loading"
      :title="title(model)" @click="emit('toggle', model)"><i v-if="pending(model)" class="gaussian-spinner" />{{ model.toUpperCase() }}：{{ pending(model) ? '准备中' : failed(model) ? '加载失败' : unsupported(model) ? '无高斯' : state.models[model].active ? '点云' : '高斯' }}</button>
  </div>
</template>
