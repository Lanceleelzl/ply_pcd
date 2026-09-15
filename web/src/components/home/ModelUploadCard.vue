<script setup lang="ts">
import type { TransformParameters } from '../../coordinate-math';
import TransformEditor from './TransformEditor.vue';

defineProps<{ model: 'a' | 'b'; file?: File; transform: TransformParameters }>();
const emit = defineEmits<{
  'update:file': [value: File | undefined];
  'update:transform': [value: TransformParameters];
}>();

function choose(event: Event): void {
  emit('update:file', (event.target as HTMLInputElement).files?.[0]);
}
</script>

<template>
  <article class="model-upload-card" :class="`model-${model}`">
    <div class="model-card-heading">
      <span class="model-letter">{{ model.toUpperCase() }}</span>
      <div>
        <h3>模型 {{ model.toUpperCase() }}</h3>
        <p>PLY、PCD、LAS、LAZ、SOG 或数据集 ZIP</p>
      </div>
    </div>
    <label class="file-dropzone">
      <input type="file" accept=".ply,.pcd,.las,.laz,.sog,.zip" required @change="choose">
      <span class="file-action">选择模型文件或数据集 ZIP</span>
      <strong>{{ file?.name ?? '尚未选择文件' }}</strong>
      <small>{{ file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : '支持大型文件流式上传' }}</small>
    </label>
    <TransformEditor :model="model" :model-value="transform" @update:model-value="emit('update:transform', $event)" />
  </article>
</template>
