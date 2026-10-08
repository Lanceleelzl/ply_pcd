<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { invertAffine, transformParametersMatrix, transformXYZ, type TransformParameters, type XYZ } from '../../coordinate-math';
import { apiFetch } from '../../api/api-auth';
import { geographicDirections, projectedToFile, wgs84Utm } from './geographic-frame';

const props = defineProps<{ taskId: string; point: XYZ; picking: boolean; referenceEditing: boolean; selectionSerial: number; transform: TransformParameters }>();
const emit = defineEmits<{ 'update:point': [point: XYZ]; notify: [message: string]; pick: []; locate: [active: boolean];
  rotate: [index: number, angle: number]; north: [up: XYZ, north: XYZ] }>();
const defaults = () => ({ axes: [1, 2, 3], confirmed: false, reference: [0, 0, 0],
  projected: ['', '', ''], unit: 1, epsg: '', height: '椭球高', mode: 'projected', longitude: '', latitude: '' });
const settings = ref(defaults());
const metadata = ref<{ source: string; epsg: string; offset: Array<string | null>; shift: Array<string | null>; scale: Array<string | null> }>();
const loadingMetadata = ref(true);
const metadataNotice = computed(() => metadata.value?.shift.some(value => value !== null && Number(value) !== 0)
  || metadata.value?.scale.some(value => value !== null && Number(value) !== 1));
const filePoint = computed(() => {
  try { return transformXYZ(invertAffine(transformParametersMatrix(props.transform)), props.point); }
  catch { return null; }
});
const message = ref('');
watch(message, value => { if (value) emit('notify', value); }, { flush: 'sync' });
const busy = ref(false);
const geographicDraft = ref(['', '', '']);
let conversionSerial = 0;
const geographic = ref<{ longitude: number; latitude: number; projected: number[]; source_name: string;
  accuracy: number; approximate: boolean; height_note: string } | null>(null);
watch(geographic, value => { if (value) geographicDraft.value = [String(value.longitude), String(value.latitude), String(value.projected[2])]; });
const axisNames = ['X', 'Y', 'Z'];
const referenceScene = computed(() => transformXYZ(transformParametersMatrix(props.transform), settings.value.reference as XYZ));
const directions = computed(() => geographicDirections(props.transform, settings.value.axes));
const locating = ref(false);
const referenceDetails = ref<HTMLDetailsElement | null>(null);
function selectReference() { locating.value = !locating.value; emit('locate', locating.value); }
watch(() => props.selectionSerial, () => {
  if (!props.referenceEditing || !filePoint.value) return;
  settings.value.reference = [...filePoint.value]; settings.value.confirmed = false;
  if (referenceDetails.value) referenceDetails.value.open = true;
  if (locating.value) {
    settings.value.projected = ['', '', '']; settings.value.longitude = ''; settings.value.latitude = '';
    locating.value = false;
    emit('notify', '定位点已选定，请填写这个点的真实坐标');
  }
});
watch(() => props.picking, (active, previous) => {
  if (!active && previous && locating.value) { locating.value = false; }
}, { flush: 'post' });
function resetReference() {
  locating.value = false; emit('locate', false);
  settings.value.reference = [0, 0, 0]; settings.value.confirmed = false;
  settings.value.mode = 'projected'; settings.value.epsg = metadata.value?.epsg ?? '';
  settings.value.projected = metadata.value?.offset.map(value => value ?? '') ?? ['', '', ''];
  settings.value.longitude = ''; settings.value.latitude = '';
}
function editReference(index: number, event: Event) {
  const scene = [...referenceScene.value] as XYZ;
  scene[index] = Number((event.target as HTMLInputElement).value);
  settings.value.reference = transformXYZ(invertAffine(transformParametersMatrix(props.transform)), scene);
  if (props.referenceEditing) emit('update:point', scene);
  settings.value.confirmed = false;
}
const coordinateInputsValid = computed(() => settings.value.mode === 'projected'
  ? settings.value.projected.every(value => value.trim() !== '' && Number.isFinite(Number(value))) && /^\d+$/.test(settings.value.epsg)
  : settings.value.longitude.trim() !== '' && settings.value.latitude.trim() !== ''
    && (!settings.value.epsg || /^\d+$/.test(settings.value.epsg))
    && Number.isFinite(Number(settings.value.longitude)) && Math.abs(Number(settings.value.longitude)) <= 180
    && Number.isFinite(Number(settings.value.latitude)) && Number(settings.value.latitude) >= -80 && Number(settings.value.latitude) <= 84
    && settings.value.projected[2].trim() !== '' && Number.isFinite(Number(settings.value.projected[2])));
const valid = computed(() => settings.value.confirmed && new Set(settings.value.axes.map(Math.abs)).size === 3
  && settings.value.unit > 0 && Number.isFinite(settings.value.unit)
  && filePoint.value?.every(Number.isFinite) && settings.value.reference.every(Number.isFinite)
  && coordinateInputsValid.value);
let queryTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleQuery() {
  if (queryTimer) clearTimeout(queryTimer);
  if (valid.value && !loadingMetadata.value) queryTimer = setTimeout(() => { void convert(); }, 250);
}
onUnmounted(() => { if (queryTimer) clearTimeout(queryTimer); });
watch(() => props.taskId, async taskId => {
  message.value = ''; geographic.value = null;
  settings.value = defaults(); loadingMetadata.value = true; metadata.value = undefined;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(`streaming-file-coordinate-${taskId}`);
    if (saved) settings.value = { ...defaults(), ...JSON.parse(saved) };
  } catch { saved = null; message.value = '本机坐标设置无法读取，请重新设置'; }
  const initial = JSON.stringify(settings.value);
  try {
    const response = await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(taskId)}/coordinate-metadata`);
    if (!response.ok) throw new Error('文件坐标信息无法预读，请手动填写');
    const data = await response.json();
    if (props.taskId !== taskId) return;
    metadata.value = data;
    if (!saved && JSON.stringify(settings.value) === initial) {
      settings.value.epsg = data.epsg;
      settings.value.projected = data.offset.map((value: string | null) => value ?? '');
    }
  } catch (error) { message.value = error instanceof Error ? error.message : String(error); }
  finally { if (props.taskId === taskId) { loadingMetadata.value = false; scheduleQuery(); } }
}, { immediate: true });
watch(settings, () => {
  geographic.value = null;
  if (loadingMetadata.value) return;
  try { localStorage.setItem(`streaming-file-coordinate-${props.taskId}`, JSON.stringify(settings.value)); }
  catch { message.value = '本机坐标设置无法保存'; }
  scheduleQuery();
}, { deep: true });
watch([() => props.point, () => props.transform], () => { geographic.value = null; scheduleQuery(); }, { deep: true });
function edit(index: number, event: Event) {
  const next = [...props.point] as XYZ;
  next[index] = Number((event.target as HTMLInputElement).value);
  emit('update:point', next);
}
const axisPreset = computed(() => {
  const axes = settings.value.axes.join(',');
  return axes === '1,2,3' ? 'z-up' : axes === '1,-3,2' ? 'y-up' : 'custom';
});
function preset(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === 'custom') return;
  settings.value.axes = value === 'z-up' ? [1, 2, 3] : [1, -3, 2];
  settings.value.confirmed = false;
}
async function copy(values: number[] | null) {
  if (!values) return;
  try { await navigator.clipboard.writeText(values.join(', ')); emit('notify', '坐标已复制'); }
  catch { emit('notify', '坐标复制失败，请检查浏览器剪贴板权限'); }
}
async function convert() {
  if (!valid.value) return;
  const serial = ++conversionSerial;
  busy.value = true; message.value = ''; geographic.value = null;
  const signature = JSON.stringify([filePoint.value, settings.value]);
  try {
    let sourceEpsg = Number(settings.value.epsg);
    let projectedOrigin = settings.value.projected.map(Number);
    if (settings.value.mode === 'wgs84') {
      if (!sourceEpsg) sourceEpsg = wgs84Utm(Number(settings.value.longitude), Number(settings.value.latitude));
      const originResponse = await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(props.taskId)}/coordinate-origin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_epsg: sourceEpsg,
          longitude: Number(settings.value.longitude), latitude: Number(settings.value.latitude) }),
      });
      const origin = await originResponse.json();
      if (!originResponse.ok) throw new Error(typeof origin.detail === 'string' ? origin.detail : '定位点转换失败');
      projectedOrigin = [origin.east, origin.north, Number(settings.value.projected[2])];
      if (signature !== JSON.stringify([filePoint.value, settings.value])) return;
    }
    const response = await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(props.taskId)}/coordinate-query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        point: filePoint.value, axes: settings.value.axes, reference: settings.value.reference,
        independent_origin: [0, 0, 0], projected_origin: projectedOrigin,
        metres_per_unit: settings.value.unit, source_epsg: sourceEpsg, target_epsg: 4326,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '坐标设置无效，请检查输入');
    if (serial === conversionSerial && signature === JSON.stringify([filePoint.value, settings.value])) geographic.value = data;
  } catch (error) {
    if (serial === conversionSerial && signature === JSON.stringify([filePoint.value, settings.value])) message.value = error instanceof Error ? error.message : String(error);
  }
  finally { if (serial === conversionSerial) busy.value = false; }
}
async function reverseQuery() {
  if (!valid.value) return;
  const values = geographicDraft.value.map(Number);
  if (geographicDraft.value.some(value => !value.trim()) || !values.every(Number.isFinite)
    || Math.abs(values[0]) > 180 || values[1] < -80 || values[1] > 84) {
    emit('notify', '请输入有效经纬度与高度，纬度范围为 −80°～84°'); return;
  }
  if (queryTimer) clearTimeout(queryTimer);
  const serial = ++conversionSerial;
  const signature = JSON.stringify([props.point, props.transform, settings.value]);
  busy.value = true;
  try {
    const sourceEpsg = Number(settings.value.epsg) || wgs84Utm(Number(settings.value.longitude), Number(settings.value.latitude));
    async function project(longitude: number, latitude: number) {
      const response = await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(props.taskId)}/coordinate-origin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_epsg: sourceEpsg, longitude, latitude }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '经纬度反算失败');
      return data;
    }
    const target = await project(values[0], values[1]);
    let origin = settings.value.projected.map(Number) as XYZ;
    if (settings.value.mode === 'wgs84') {
      const anchor = await project(Number(settings.value.longitude), Number(settings.value.latitude));
      origin = [anchor.east, anchor.north, origin[2]];
    }
    if (serial !== conversionSerial || signature !== JSON.stringify([props.point, props.transform, settings.value])) return;
    const file = projectedToFile([target.east, target.north, values[2]], origin, settings.value.reference as XYZ,
      settings.value.axes, settings.value.unit, target.metres_per_projected_unit);
    const scene = transformXYZ(transformParametersMatrix(props.transform), file);
    if (!scene.every(Number.isFinite)) throw new Error('反算结果无效，请检查定位设置');
    emit('update:point', scene);
  } catch (error) {
    if (serial === conversionSerial) emit('notify', error instanceof Error ? error.message : String(error));
  } finally { if (serial === conversionSerial) busy.value = false; }
}
</script>

<template>
  <section class="query-content">
    <section class="query-coordinates">
    <div class="query-section-heading"><h3>场景坐标</h3><button class="query-pick-button" type="button" :class="{ active: picking }" :aria-pressed="picking" :aria-label="picking ? '取消选点' : '选点'" :title="picking ? '取消选点' : '选点'" @click="emit('pick')"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V5a1.5 1.5 0 0 1 3 0v6-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v7c0 4-2 6-6 6h-1c-2 0-3-1-4-2l-5-6a1.5 1.5 0 0 1 2-2l2 2Z" /></svg></button></div>
    <div class="query-scene-fields"><label v-for="(axis, index) in axisNames" :key="axis"><span>{{ axis }}</span><input :value="point[index]" :title="String(point[index])" type="number" step="any" :aria-label="`场景 ${axis}`" @change="edit(index, $event)"></label></div>
    <button @click="copy(point)">复制</button>
    </section>
    <Teleport defer to="#streaming-coordinate-settings"><section class="query-settings"><h3>地理定位</h3>
      <details><summary>摆正模型</summary>
        <label v-for="(axis, index) in axisNames" :key="axis" class="field-row"><span>{{ axis }} 旋转</span><select :value="transform.rotation_degrees[index]" :aria-label="`${axis} 旋转快捷角度`" @change="emit('rotate', index, Number(($event.target as HTMLSelectElement).value))"><option v-if="![0, 90, 180, -90, -180].includes(transform.rotation_degrees[index])" :value="transform.rotation_degrees[index]">{{ transform.rotation_degrees[index] }}°</option><option v-for="angle in [0, 90, 180, -90, -180]" :key="angle" :value="angle">{{ angle }}°</option></select></label>
        <p class="muted">只调整场景显示，同一点的真实地理位置保持不变。</p>
      </details>
      <button :disabled="new Set(settings.axes.map(Math.abs)).size !== 3" @click="emit('north', directions[2], directions[1])">北向俯视</button>
      <h4>定位参考点</h4>
      <p class="muted">默认模型原点；已有其他已知点时，可重新选取。</p>
      <button @click="selectReference">{{ locating ? '取消定位选点' : '选定位点' }}</button><button @click="resetReference">使用模型原点</button>
      <details ref="referenceDetails"><summary>参考点的场景 XYZ</summary><div class="xyz-fields scene-coordinate-fields"><label v-for="(axis, index) in axisNames" :key="axis"><input :value="referenceScene[index]" type="number" step="any" :aria-label="`定位点场景 ${axis}`" @change="editReference(index, $event)"><span>{{ axis }}</span></label></div></details>
      <p v-if="loadingMetadata" class="muted">正在预读文件坐标信息……</p>
      <p v-else class="muted">{{ metadata?.source ? `文件来源：${metadata.source}。` : '' }}{{ metadata?.epsg || metadata?.offset.some(value => value !== null) ? '已预读文件注释，请核对。' : '文件未提供完整定位信息，请手动填写。' }}</p>
      <label class="field-row"><span>已知坐标</span><select v-model="settings.mode" aria-label="定位坐标类型" @change="settings.confirmed = false"><option value="projected">投影坐标</option><option value="wgs84">WGS84 经纬度</option></select></label>
      <template v-if="settings.mode === 'projected'"><label class="field-row"><span>源投影 EPSG</span><input v-model="settings.epsg" aria-label="定位投影 EPSG" placeholder="例如 32651" inputmode="numeric"></label>
      <label v-for="(axis, index) in ['x', 'y']" :key="axis">{{ ['东坐标 E／offsetx', '北坐标 N／offsety'][index] }}<input v-model="settings.projected[index]" type="text" inputmode="decimal" :aria-label="`offset${axis}`" placeholder="填写定位参考点的真实坐标"></label></template>
      <template v-else><label>经度<input v-model="settings.longitude" aria-label="定位经度" inputmode="decimal"></label><label>纬度<input v-model="settings.latitude" aria-label="定位纬度" inputmode="decimal"></label></template>
      <label>参考点高度／offsetz<input v-model="settings.projected[2]" type="text" inputmode="decimal" aria-label="offsetz" placeholder="填写参考点高度"></label>
      <label class="field-row"><span>高度基准</span><select v-model="settings.height" aria-label="高度基准"><option>未确认</option><option>椭球高</option><option>海拔高</option><option>局部高度</option></select></label>
      <p class="muted">原始模型：{{ settings.axes.map((axis, index) => `${['东', '北', '上'][index]}＝${axis > 0 ? '＋' : '−'}${axisNames[Math.abs(axis) - 1]}`).join('，') }}；单位{{ settings.unit === 1 ? '米' : settings.unit === 0.01 ? '厘米' : '毫米' }}。</p>
      <details><summary>坐标与高度说明</summary><p class="muted">高度默认采用其域原始 RTK 的椭球高说明。已做高程修正或其他来源的数据，可切换高度基准；此处不转换高程基准。</p>
      <p class="muted">默认文件 X＝东、Y＝北、Z＝上，单位米；投影坐标＝文件坐标＋offset。已有绝对投影坐标时，确认后填零偏移。</p></details>
      <p v-if="metadataNotice" class="muted">文件含非默认 shift／scale 注释，其含义需核对，本工具未自动套用这些注释。</p>
      <details><summary>高级设置：轴向与单位</summary>
        <label class="field-row"><span>坐标轴预设</span><select :value="axisPreset" aria-label="坐标轴预设" @change="preset"><option value="z-up">＋Z 向上</option><option value="y-up">＋Y 向上</option><option v-if="axisPreset === 'custom'" value="custom">自定义</option></select></label>
        <p class="muted">预设后请核对下方的东、北、上方向；模型前向不一定是真实北向。</p>
        <label v-for="(name, index) in ['东', '北', '上']" :key="name" class="field-row"><span>{{ name }}</span><select v-model.number="settings.axes[index]" @change="settings.confirmed = false"><option v-for="axis in [1, -1, 2, -2, 3, -3]" :key="axis" :value="axis">{{ axis > 0 ? '＋' : '−' }}{{ axisNames[Math.abs(axis) - 1] }}</option></select></label>
        <label class="field-row"><span>单位</span><select v-model.number="settings.unit" @change="settings.confirmed = false"><option :value="1">米</option><option :value="0.01">厘米</option><option :value="0.001">毫米</option></select></label>
        <p class="muted">东／北偏移采用源 EPSG 单位，高度使用米。</p>
        <label v-if="settings.mode === 'wgs84'">投影 EPSG（可留空，按经纬度选 UTM）<input v-model="settings.epsg" aria-label="定位投影 EPSG" inputmode="numeric"></label>
        <p class="muted">场景中的地理方向会随观察旋转自动换算：</p><p v-for="(vector, index) in directions" :key="index" class="muted">{{ ['东', '北', '上'][index] }}＝{{ vector.map((value, axis) => `${Math.abs(value) < 1e-8 ? 0 : Number(value.toFixed(3))} ${axisNames[axis]}`).join('，') }}</p>
      </details>
      <label><input v-model="settings.confirmed" type="checkbox">已确认参考点坐标与模型轴向</label>
      <p class="muted">设置仅保存在本机当前任务中，不改变模型和生成数据。</p>
    </section></Teleport>
    <section class="query-results"><div class="query-section-heading"><h3>查询结果</h3></div>
    <template v-if="valid"><label>经度<input v-model="geographicDraft[0]" inputmode="decimal" aria-label="WGS84 经度" @change="reverseQuery"></label><label>纬度<input v-model="geographicDraft[1]" inputmode="decimal" aria-label="WGS84 纬度" @change="reverseQuery"></label><label>高度<input v-model="geographicDraft[2]" inputmode="decimal" aria-label="查询高度" @change="reverseQuery"></label><button :disabled="!geographic || busy" @click="copy(geographicDraft.map(Number))">复制</button></template>
    <p v-else class="muted">{{ valid ? '正在更新查询结果' : '请先在左侧确认地理定位' }}</p>
    </section>
  </section>
</template>
