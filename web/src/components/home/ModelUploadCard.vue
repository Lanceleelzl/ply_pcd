<script setup lang="ts">
import type { TransformParameters } from '../../coordinate-math';
import type { ModelUploadSelection } from '../../api/contracts';
import { ref } from 'vue';
import TransformEditor from './TransformEditor.vue';

interface PickedFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

interface PickedDirectoryHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<PickedFileHandle | PickedDirectoryHandle>;
}

const props = defineProps<{ model: 'a' | 'b'; file?: ModelUploadSelection; transform: TransformParameters }>();
const emit = defineEmits<{
  'update:file': [value: ModelUploadSelection | undefined];
  'update:transform': [value: TransformParameters];
}>();
const fallbackDirectoryInput = ref<HTMLInputElement>();

async function isGaussianPly(file: File): Promise<boolean> {
  const header = await file.slice(0, 256 * 1024).text();
  const end = header.indexOf('end_header');
  if (end < 0) return false;
  const text = header.slice(0, end);
  const properties = new Set(
    text.split(/\r?\n/).filter(line => line.startsWith('property ')).map(line => line.trim().split(/\s+/).at(-1)),
  );
  return (text.includes('element chunk ') && properties.has('packed_position'))
    || (text.includes('format binary_little_endian ')
      && ['scale_0', 'scale_1', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'opacity'].every(name => properties.has(name)));
}

async function supportsStreamCache(files: File[], shape: 'file' | 'directory'): Promise<boolean> {
  if (shape === 'directory') {
    const names = files.map(item => item.name.toLowerCase());
    if (names.includes('lod-meta.json')) return false;
    return names.some(name => /\.lcc2?$/.test(name)) || names.includes('meta.json');
  }
  const file = files[0];
  const name = file.name.toLowerCase();
  if (name.endsWith('.ply')) return isGaussianPly(file);
  return ['.spz', '.sog', '.zip'].some(extension => name.endsWith(extension));
}

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
  const streamCacheEligible = await supportsStreamCache(selected, shape);
  emit('update:file', {
    files: selected,
    shape,
    label: label ?? (shape === 'directory' ? (relative.split('/')[0] || '数据集目录') : selected[0].name),
    bytes: selected.reduce((total, item) => total + item.size, 0),
    streamCache: false,
    streamCacheEligible,
    paths,
  });
}

async function choose(event: Event, shape: 'file' | 'directory'): Promise<void> {
  const selected = Array.from((event.target as HTMLInputElement).files ?? []);
  await applySelection(selected, shape);
}

async function collectDirectoryFiles(
  directory: PickedDirectoryHandle,
  prefix: string,
  files: File[],
  paths: string[],
): Promise<void> {
  const entries: (PickedFileHandle | PickedDirectoryHandle)[] = [];
  for await (const entry of directory.values()) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.kind === 'file') {
      files.push(await entry.getFile());
      paths.push(relative);
    } else {
      await collectDirectoryFiles(entry, relative, files, paths);
    }
  }
}

async function chooseDirectory(): Promise<void> {
  const picker = (window as unknown as {
    showDirectoryPicker?: () => Promise<PickedDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) {
    fallbackDirectoryInput.value?.click();
    return;
  }
  try {
    const directory = await picker();
    const files: File[] = [];
    const paths: string[] = [];
    await collectDirectoryFiles(directory, directory.name, files, paths);
    await applySelection(files, 'directory', directory.name, paths);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    throw error;
  }
}

const canGenerateStreamCache = () => Boolean(props.file?.streamCacheEligible);

function updateStreamCache(event: Event): void {
  if (!props.file) return;
  emit('update:file', { ...props.file, streamCache: (event.target as HTMLInputElement).checked });
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
      <label v-if="canGenerateStreamCache()" class="dataset-cache-option">
        <input type="checkbox" :checked="file?.streamCache" @change="updateStreamCache">
        <strong>生成流式缓存</strong>
        <small>勾选后会生成对应的流式缓存，不影响配准；缓存完成后将使用流式数据加载。</small>
        <small v-if="file?.streamCache" class="cache-tracking-hint">提交后可在页面顶部「后台任务」中持续查看生成状态。</small>
      </label>
    </div>
    <TransformEditor :model="model" :model-value="transform" @update:model-value="emit('update:transform', $event)" />
  </article>
</template>
