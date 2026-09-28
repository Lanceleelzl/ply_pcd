<script setup lang="ts">
import type { TransformParameters } from '../../coordinate-math';
import type { ModelUploadSelection } from '../../api/contracts';
import { ref } from 'vue';
import TransformEditor from './TransformEditor.vue';
import { pickDirectory } from '../../shared/directory-selection';

const props = defineProps<{ model: 'a' | 'b'; file?: ModelUploadSelection; transform: TransformParameters }>();
const emit = defineEmits<{
  'update:file': [value: ModelUploadSelection | undefined];
  'update:transform': [value: TransformParameters];
}>();
const fallbackDirectoryInput = ref<HTMLInputElement>();

async function applySelection(
  selected: File[],
  shape: 'file' | 'directory',
  label?: string,
  paths?: string[],
): Promise<void> {
  if (!selected.length) {
    emit('update:file', undefined);
    return;
  }
  const relative = selected[0].webkitRelativePath;
  emit('update:file', {
    files: selected,
    shape,
    label: label ?? (shape === 'directory' ? (relative.split('/')[0] || '数据集目录') : selected[0].name),
    bytes: selected.reduce((total, item) => total + item.size, 0),
    paths,
  });
}

async function choose(event: Event, shape: 'file' | 'directory'): Promise<void> {
  const selected = Array.from((event.target as HTMLInputElement).files ?? []);
  await applySelection(selected, shape);
}

async function chooseDirectory(): Promise<void> {
  const selection = await pickDirectory(() => fallbackDirectoryInput.value?.click());
  if (selection) await applySelection(selection.files, 'directory', selection.name, selection.paths);
}

</script>

<template>
  <article class="model-upload-card" :class="`model-${model}`">
    <div class="model-card-heading">
      <span class="model-letter">{{ model.toUpperCase() }}</span>
      <div>
        <h3>模型 {{ model.toUpperCase() }}</h3>
        <p>PLY、PCD、LAS、LAZ、SOG、SPZ 或数据集 ZIP</p>
      </div>
    </div>
    <div class="file-dropzone">
      <div class="file-choices">
        <label class="file-action" :class="{ active: file?.shape === 'file' }">
          <input type="file" accept=".ply,.pcd,.las,.laz,.sog,.spz,.zip" @change="choose($event, 'file')">
          选择文件／ZIP
        </label>
        <button type="button" class="file-action" :class="{ active: file?.shape === 'directory' }" @click="chooseDirectory">
          选择数据集目录
        </button>
        <input ref="fallbackDirectoryInput" class="directory-input-fallback" type="file" webkitdirectory multiple @change="choose($event, 'directory')">
      </div>
      <strong>{{ file ? `${file.shape === 'directory' ? '已选择目录' : '已选择文件'}：${file.label}` : '尚未选择数据' }}</strong>
      <small>{{ file ? `${file.files.length} 个文件，${(file.bytes / 1024 / 1024).toFixed(1)} MB` : '目录上传保留相对路径' }}</small>
      <p class="dataset-guidance">
        LCC：选择包含唯一 <code>.lcc</code>、<code>Index.bin</code>、<code>Data.bin</code> 的目录；
        LCC2：选择包含唯一 <code>.lcc2</code> 和完整 <code>data/</code> 的目录。
      </p>
    </div>
    <TransformEditor :model="model" :model-value="transform" @update:model-value="emit('update:transform', $event)" />
  </article>
</template>
