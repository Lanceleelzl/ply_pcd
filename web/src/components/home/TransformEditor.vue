<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { transformParametersMatrix, type TransformParameters } from '../../coordinate-math';
import { decomposeMatrix, parseMatrix } from '../../home-matrix';
const props = defineProps<{ model: 'a' | 'b'; modelValue: TransformParameters }>();
const emit = defineEmits<{ 'update:modelValue': [value: TransformParameters] }>();
const axes = ['X', 'Y', 'Z'];
const rows = [{ key: 'translation' as const, label: '平移／m' }, { key: 'rotation_degrees' as const, label: '旋转／°' }, { key: 'scale' as const, label: '缩放' }];
const fields = ref({ translation: [] as string[], rotation_degrees: [] as string[], scale: [] as string[] });
const cells = ref<string[][]>([]);
const message = ref('');
const invalid = ref(false);
const root = ref<HTMLElement>();
async function selectValue(event: FocusEvent) {
  const input = event.target as HTMLInputElement;
  await nextTick();
  if (document.activeElement === input) input.select();
}
function focusValue(event: PointerEvent) {
  const input = event.target as HTMLInputElement;
  if (event.button === 0 && document.activeElement !== input) {
    event.preventDefault();
    input.focus();
  }
}
watch([invalid, message], () => {
  root.value?.querySelector('input')?.setCustomValidity(invalid.value ? message.value : '');
}, { flush: 'post' });
watch(() => props.modelValue, value => {
  for (const row of rows) fields.value[row.key] = value[row.key].map(String);
  cells.value = transformParametersMatrix(value).map(row => row.map(String));
}, { immediate: true, deep: true });
function fail(reason: unknown) { invalid.value = true; message.value = reason instanceof Error ? reason.message : String(reason); }
function publish(value: TransformParameters) { invalid.value = false; message.value = ''; emit('update:modelValue', value); }
function commitParameters() {
  try {
    const value = Object.fromEntries(rows.map(row => [row.key, fields.value[row.key].map(text => {
      if (!text.trim() || !Number.isFinite(Number(text))) throw new Error('请输入完整的有效数值');
      return Number(text);
    })])) as unknown as TransformParameters;
    decomposeMatrix(transformParametersMatrix(value));
    publish(value);
  } catch (reason) { fail(reason); }
}
function commitMatrix() {
  try { publish(decomposeMatrix(parseMatrix(cells.value.flat().join(' ')))); }
  catch (reason) { fail(reason); }
}
function pasteText(text: string) {
  try { publish(decomposeMatrix(parseMatrix(text))); }
  catch (reason) { fail(reason); }
}
function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') ?? '';
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return;
  event.preventDefault(); pasteText(text);
}
async function paste() {
  try { pasteText(await navigator.clipboard.readText()); }
  catch { fail(new Error('无法读取剪贴板，请聚焦矩阵输入框后按 Ctrl＋V')); }
}
async function copy() {
  try { await navigator.clipboard.writeText(transformParametersMatrix(props.modelValue).map(row => row.join(' ')).join('\n')); message.value = '已复制矩阵'; }
  catch { fail(new Error('无法写入剪贴板')); }
}
</script>
<template>
  <details ref="root" class="transform-disclosure" @invalid.capture="($event.currentTarget as HTMLDetailsElement).open = true" @focusin="($event.target as HTMLElement).tagName === 'INPUT' && selectValue($event)" @pointerdown="($event.target as HTMLElement).tagName === 'INPUT' && focusValue($event)">
    <summary>业务场景矩阵</summary>
    <header class="transform-heading"><span /><button type="button" @click="publish({ translation: [0,0,0], rotation_degrees: [0,0,0], scale: [1,1,1] })">重置</button></header>
    <p>模型初始加载进场景中有进行位移、旋转、放缩等初始转换时，需填入对应矩阵；否则默认即可。</p>
    <div v-for="row in rows" :key="row.key" class="transform-field-row">
      <span>{{ row.label }}</span>
      <label v-for="(axis, index) in axes" :key="axis" class="axis-field">
        <input v-model="fields[row.key][index]" type="text" inputmode="decimal" :aria-label="`模型 ${model.toUpperCase()} ${row.label} ${axis}`" @blur="commitParameters" @keydown.enter.prevent="commitParameters" :aria-invalid="invalid">
        <span>{{ axis }}</span>
      </label>
    </div>
    <div class="matrix-preview" @paste="onPaste">
      <header class="transform-heading"><strong>转换矩阵 4×4</strong><div><button type="button" @click="paste">粘贴</button><button type="button" @click="copy">复制</button></div></header>
      <div class="matrix-input-grid">
        <template v-for="(row, r) in cells" :key="r"><input v-for="(_, c) in row" :key="c" v-model="cells[r][c]" type="text" inputmode="decimal" :readonly="r === 3" :aria-label="`模型 ${model.toUpperCase()} 矩阵 ${r + 1}行 ${c + 1}列`" :title="cells[r][c]" @blur="commitMatrix" @keydown.enter.prevent="commitMatrix"></template>
      </div>
    </div>
    <p class="transform-feedback" :class="{ 'error-text': invalid }" role="status">{{ message || '编辑完成后同步参数与矩阵，支持整块粘贴' }}</p>
  </details>
</template>
