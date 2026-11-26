<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { GaussianViewer } from '../../engine/modules/GaussianViewer';
import type { XYZ } from '../../coordinate-math';
import { convertOrigin, definition, isGeographic, metricCode, type GeoOrigin } from './viewer-origin';


import { annotationCoordinates } from './annotation-coordinates';
interface Model { id:number; name:string; origin?:GeoOrigin; heightDatum:string; visible:boolean }
const props = defineProps<{ canvas: HTMLCanvasElement; engine: () => GaussianViewer | undefined; active: boolean; models:Model[]; preferred:number }>();
const emit = defineEmits<{ select: [] }>();
const marks = reactive<{ point: XYZ; modelId:number; screen?: { x: number; y: number } }[]>([]);
const index = ref(0), selected = computed(() => marks[index.value]);
const targetId=ref(0), creating=ref(false), error=ref('');
const editing=computed(()=>creating.value ? undefined : selected.value);
const model=computed(()=>props.models.find(m=>m.id===(editing.value?.modelId ?? targetId.value)));
const origin=computed(()=>model.value?.origin);
const frame=computed(()=>origin.value && convertOrigin(origin.value,metricCode(origin.value)));
const geographic=computed(()=>!!origin.value && isGeographic(origin.value.epsg));
const northFirst=computed(()=>!!origin.value && origin.value.epsg>=4491 && origin.value.epsg<=4554);
function chooseModel(id:number) {
  const previous=marks.findIndex(mark=>mark.modelId===id);
  targetId.value=id;
  creating.value=previous<0;
  if(previous>=0) index.value=previous;
}
watch([()=>props.preferred,()=>props.models.map(m=>m.id).join(',')],()=>{
  const ids=props.models.map(m=>m.id);
  const current=selected.value;
  for(let i=marks.length-1;i>=0;i--) if(!ids.includes(marks[i].modelId)) marks.splice(i,1);
  if(current && marks.includes(current)) index.value=marks.indexOf(current);
  chooseModel(ids.includes(props.preferred) ? props.preferred : ids.includes(targetId.value) ? targetId.value : ids[0] ?? 0);
},{immediate:true});
const values = ref<string[]>([]);
const displayed = computed(()=>{
  if(!editing.value) return;
  const p=frame.value ? annotationCoordinates(frame.value,definition(origin.value!.epsg),editing.value.point,false) : [...editing.value.point];
  return northFirst.value ? [p[1],p[0],p[2]] : p;
});
watch([displayed,model], () => {
  values.value = displayed.value?.map(String) ?? ['','',''];
  error.value = '';
}, { immediate: true });
watch(editing,mark=>{if(mark) targetId.value=mark.modelId;});
function addPoint(point: XYZ, modelId:number) {
  targetId.value=modelId;
  marks.push({point,modelId});
  creating.value=false;
  index.value=marks.length-1;
  if(!animation) updateScreen();
}
function apply() {
  setPicking(false);
  if(!model.value) return;
  const numbers = values.value.map(v => String(v).trim() ? Number(v) : NaN) as XYZ;
  try {
    if (numbers.length!==3 || !numbers.every(Number.isFinite)) throw Error('请填写三个有效坐标值');
    if (geographic.value && frame.value && (Math.abs(numbers[0])>180 || Math.abs(numbers[1])>90)) throw Error('经纬度超出有效范围');
    const input:XYZ = northFirst.value ? [numbers[1],numbers[0],numbers[2]] : numbers;
    const point=frame.value ? annotationCoordinates(frame.value,definition(origin.value!.epsg),input,true) : input;
    if (!point.every(Number.isFinite)) throw Error('坐标超出投影范围');
    if(editing.value && displayed.value) {
      if(numbers[0]===displayed.value[0] && numbers[1]===displayed.value[1]) [point[0],point[1]]=editing.value.point;
      if(numbers[2]===displayed.value[2]) point[2]=editing.value.point[2];
      editing.value.point=point;

    } else addPoint(point,model.value.id);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
let start: PointerEvent | undefined, dismissStart: PointerEvent | undefined, revision = 0, animation = 0;
const picking = ref(false);
const handleActive = ref(false);
const hover = ref<{x:number;y:number}>();
let pointer: {x:number;y:number} | undefined;
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
let readingHover=false;
let hoverRevision=0;
function clearHover() {
  hoverRevision++;
  clearTimeout(hoverTimer);
  hoverTimer=undefined;
  pointer=undefined;
  hover.value=undefined;
}
function scheduleHover() {
  if(!pointer || readingHover || hoverTimer!==undefined) return;
  hoverTimer=setTimeout(async ()=>{
    hoverTimer=undefined;
    const sample=pointer;
    if(!sample) return;
    const request=hoverRevision;
    readingHover=true;
    try {
      const engine=props.engine();
      const hit=await engine?.annotationPick(sample.x,sample.y);
      if(request!==hoverRevision || !pointer) return;
      if(Math.hypot(pointer.x-sample.x,pointer.y-sample.y)>4) { hover.value=undefined; return; }
      hover.value=hit ? hit.screen : undefined;
    } catch {
      if(pointer===sample) hover.value=undefined;
    } finally {
      readingHover=false;
      if(pointer!==sample) scheduleHover();
    }
  },25);
}
function setPicking(value: boolean) {
  clearHover();
  revision++;
  start = undefined;
  dismissStart = undefined;
  error.value = '';
  picking.value = value;
  if (value) handleActive.value = false;
  props.canvas.classList.toggle('annotation-picking',value);
}
function down(e: PointerEvent) {
  clearHover();
  start = props.active && picking.value && e.button === 0 ? e : undefined;
  dismissStart = props.active && !picking.value && handleActive.value && e.button === 0 ? e : undefined;
}
function moved(e: PointerEvent) {
  if (start && Math.hypot(e.clientX-start.clientX,e.clientY-start.clientY)>4) start=undefined;
  if (dismissStart && Math.hypot(e.clientX-dismissStart.clientX,e.clientY-dismissStart.clientY)>4) dismissStart=undefined;
  if(!picking.value || e.buttons || e.pointerType==='touch') return;
  const rect=props.canvas.getBoundingClientRect();
  if(hover.value && Math.hypot(e.clientX-rect.left-hover.value.x,e.clientY-rect.top-hover.value.y)>4) hover.value=undefined;
  pointer={x:e.clientX,y:e.clientY};
  scheduleHover();
}
async function up(e: PointerEvent) {
  const dismiss = dismissStart;
  dismissStart = undefined;
  if (dismiss && dismiss.pointerId === e.pointerId && e.button === 0) {
    if (!props.engine()?.consumeAnnotationInteraction()) handleActive.value = false;
  }
  const initial = start;
  start = undefined;
  if (!props.active || initial?.pointerId !== e.pointerId || e.button !== 0) return;
  const request = ++revision;
  try {
    const point = await props.engine()?.annotationPick(e.clientX,e.clientY);
    if (request !== revision) return;
    if (!point) { error.value='此处未拾取到高斯模型'; return; }
    setPicking(false);
    addPoint(point.point,point.id);
  } catch { if (request === revision) error.value = '读取模型深度失败'; }
}
function updateScreen() {
  for (const mark of marks) {
    const engine=props.engine();
    const world=props.models.find(m=>m.id===mark.modelId)?.visible && engine?.annotationPosition(mark.modelId,mark.point);
    const s=world && engine?.annotationScreen(world);
    if (!s) mark.screen = undefined;
    else if (mark.screen?.x !== s.x || mark.screen?.y !== s.y) mark.screen = {x:s.x,y:s.y};
  }
  animation = requestAnimationFrame(updateScreen);
}
function selectMark(i: number) {
  setPicking(false);
  creating.value = false;
  index.value = i;
  handleActive.value = true;
  emit('select');
}
function syncHandle() {
  const engine = props.engine();
  if (!engine) return;
  const mark = props.active && handleActive.value && !picking.value && !creating.value ? selected.value : undefined;
  const visible = mark && props.models.find(m => m.id === mark.modelId)?.visible;
  const world = mark && visible ? engine.annotationPosition(mark.modelId, mark.point) : undefined;
  if (!mark || !world) {
    engine.setAnnotationHandle(undefined);
    return;
  }
  engine.setAnnotationHandle(world, nextWorld => {
    const local = engine.annotationPosition(mark.modelId, nextWorld, true);
    if (local) mark.point = local;
  });
}
watch(
  [
    () => props.active,
    handleActive,
    picking,
    creating,
    () => selected.value?.modelId,
    () => selected.value?.point,
    () => props.models.map(m => `${m.id}:${m.visible}`).join(','),
  ],
  syncHandle,
  { immediate: true },
);
watch(() => props.active, active => {
  setPicking(false);
  if (!active) handleActive.value = false;
  syncHandle();
});
const events=new AbortController();
onMounted(()=>{
  const opts={capture:true,signal:events.signal};
  props.canvas.addEventListener('pointerdown',down,opts);
  props.canvas.addEventListener('pointermove',moved,opts);
  props.canvas.addEventListener('pointerleave',clearHover,opts);
  props.canvas.addEventListener('wheel',clearHover,opts);
  props.canvas.addEventListener('keydown',clearHover,opts);
  props.canvas.addEventListener('pointerup',up,opts);
  props.canvas.addEventListener('pointercancel',()=>{start=undefined;dismissStart=undefined;},opts);
  syncHandle();
});
onUnmounted(()=>{props.engine()?.setAnnotationHandle(undefined);setPicking(false);events.abort();cancelAnimationFrame(animation);});
</script>
<template>
  <span v-if="hover" aria-hidden="true" class="annotation-hit" :style="{left:hover.x+'px',top:hover.y+'px'}"></span>
  <div v-for="(mark,i) in marks" :key="i" v-show="mark.screen" class="marker" :class="{active: active && handleActive && !creating && index===i}"
    :style="{left:mark.screen?.x+'px',top:mark.screen?.y+'px'}">
    <button type="button" :aria-label="'标注点 '+(i+1)" :aria-pressed="active && handleActive && !creating && index===i" title="点击选中并显示三维平移手柄" @click="selectMark(i)">{{i+1}}</button>
  </div>
  <Teleport v-if="active" to="#annotation-fields">
    <div class="annotation-form">
    <label class="field">目标模型<select aria-label="目标模型" :value="model?.id" @change="setPicking(false);chooseModel(Number(($event.target as HTMLSelectElement).value))">
      <option v-for="m in models" :key="m.id" :value="m.id">{{m.name}}</option></select></label>
    <button class="apply-origin" type="button" :disabled="!models.length" :aria-pressed="picking" @click="setPicking(!picking)">{{picking ? '取消拾取' : '拾取坐标'}}</button>
    <p v-if="picking" role="status">请单击高斯模型上要标注的位置。</p>
    <button v-if="selected && !creating" class="apply-origin" @click="setPicking(false);creating=true">按坐标新建</button>
    <button v-if="creating && selected" class="cancel-origin" @click="setPicking(false);creating=false">返回当前点</button>
      <label v-if="editing" class="field">标注点<select v-model.number="index"><option v-for="(_,i) in marks" :key="i" :value="i">点 {{i+1}}</option></select></label>
      <p v-if="origin">{{origin.epsg>=4490 && origin.epsg<=4554 ? 'CGCS2000' : geographic || [326,327].includes(Math.floor(origin.epsg/100)) || origin.epsg===3857 ? 'WGS 84' : '模型坐标系'}}（EPSG:{{origin.epsg}}）</p>
      <p v-else>{{model ? '模型未设置地理原点，使用模型局部 XYZ。' : '请先加载模型。'}}</p>
      <p v-if="model">模型高程基准：{{model.heightDatum}}</p>
      <form v-if="model" @submit.prevent="apply">
        <label v-for="(label,i) in (frame ? geographic ? ['经度（°）','纬度（°）','高程（米）'] : northFirst ? ['北坐标 X','东坐标 Y','高程（米）'] : ['东坐标 E','北坐标 N','高程（米）'] : ['X','Y','Z'])" :key="i" class="field">{{label}}<input v-model="values[i]" required type="number" step="any"></label>
        <button class="apply-origin" type="submit">{{editing ? '应用坐标' : '添加标注'}}</button>
      </form>
    <p v-if="error" role="status">{{error}}</p>
    </div>
  </Teleport>
</template>
<style scoped>
:global(canvas.annotation-picking){cursor:crosshair}
.marker{position:absolute;transform:translate(-50%,-50%)}
.marker button{border:2px solid white;border-radius:50%;background:#057894;color:white;min-width:24px;height:24px;cursor:pointer}
.marker.active button{border-color:#65eeff;box-shadow:0 0 0 2px #143040}
.annotation-form,.annotation-form form{display:grid;gap:9px}
.annotation-form p{margin:0}
.annotation-form button[aria-pressed=true]{color:var(--active);border-color:var(--active)}
.annotation-hit{position:absolute;pointer-events:none;transform:translate(-50%,-50%);width:16px;height:16px;border:2px solid #65eeff;border-radius:50%;box-shadow:0 0 0 1px #143040,inset 0 0 0 1px #143040;display:grid;place-items:center}
.annotation-hit::after{content:'';width:4px;height:4px;border-radius:50%;background:white;box-shadow:0 0 0 1px #143040}
</style>
