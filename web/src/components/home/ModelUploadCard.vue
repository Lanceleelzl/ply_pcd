<script setup lang="ts">
import type { TransformParameters } from '../../coordinate-math';
import type { ModelUploadSelection } from '../../api/contracts';
import TransformEditor from './TransformEditor.vue';

defineProps<{ model: 'a' | 'b'; file?: ModelUploadSelection; transform: TransformParameters }>();
const emit = defineEmits<{
  'update:file': [value: ModelUploadSelection | undefined];
  'update:transform': [value: TransformParameters];
}>();

function choose(event: Event, shape: 'file' | 'directory'): void {
  const selected = Array.from((event.target as HTMLInputElement).files ?? []);
  if (!selected.length) {
    emit('update:file', undefined);
    return;
  }
  const relative = selected[0].webkitRelativePath;
  emit('update:file', {
    files: selected,
    shape,
    label: shape === 'directory' ? (relative.split('/')[0] || '数据集目录') : selected[0].name,
    bytes: selected.reduce((total, item) => total + item.size, 0),
  });
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
    <div class="file-dropzone">
      <div class="file-choices">
        <label class="file-action"><input type="file" accept=".ply,.pcd,.las,.laz,.sog,.zip" @change="choose($event, 'file')">选择文件／ZIP</label>
        <label class="file-action"><input type="file" webkitdirectory multiple @change="choose($event, 'directory')">选择数据集目录</label>
      </div>
      <strong>{{ file?.label ?? '尚未选择数据' }}</strong>
      <small>{{ file ? `${file.files.length} 个文件，${(file.bytes / 1024 / 1024).toFixed(1)} MB` : '目录上传保留相对路径' }}</small>
    </div>
    <TransformEditor :model="model" :model-value="transform" @update:model-value="emit('update:transform', $event)" />
  </article>
</template>
