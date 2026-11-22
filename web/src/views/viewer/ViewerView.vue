<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import ViewportCube from '../../components/ViewportCube.vue';
import { providers, readMapService, type Provider, type RasterLayer } from './map-service';
import type { MapOptions } from './project-map';
import ViewerIcon from './ViewerIcon.vue';
import TransformEditor from '../../components/home/TransformEditor.vue';
import type { TransformParameters } from '../../coordinate-math';
import { readOrigin, convertOrigin, geographicPosition, sceneOffset, type GeoOrigin } from './viewer-origin';
import { wgs84Utm } from '../streaming/geographic-frame';
import { mountViewControls } from '../workbench/view-controls';
import '../../view-gizmo.css';
import { GaussianViewer } from '../../engine/modules/GaussianViewer';
import { collectDirectoryFiles, pickDirectory, type PickedDirectoryHandle } from '../../shared/directory-selection';
import { localModel } from './local-model';
const canvas = ref<HTMLCanvasElement>(),
  viewport = ref<HTMLElement>();
const filePicker = ref<HTMLInputElement>(),
  directoryPicker = ref<HTMLInputElement>();
const menu = ref<HTMLDetailsElement>();
const layers = reactive<
  {
    id: number;
    name: string;
    visible: boolean;
    status: string;
    loading: boolean;
    geo: string;
    origin?: GeoOrigin;
    projected?: boolean;
    originDraft?: { epsg: string; offset: [string, string, string]; message: string };
    baseline?: TransformParameters;
    transform: TransformParameters;
  }[]
>([]);
const selectedId = ref(0);
const layersOpen = ref(false);
type Panel = 'properties' | 'clip' | 'settings' | 'map';
const panel = ref<Panel>();
function togglePanel(next: Panel) {
  panel.value = panel.value === next ? undefined : next;
}
function selectLayer(id: number) {
  selectedId.value = id;
  panel.value = 'properties';
}
const selected = computed(() => layers.find((l) => l.id === selectedId.value));
const transformOpen = ref(false);
watch([panel, selectedId], () => { transformOpen.value = false; });
const box = ref<TransformParameters>({
  translation: [0, 0, 0],
  rotation_degrees: [0, 0, 0],
  scale: [10, 10, 10],
});
function updateTool() {
  if (axis.value === 'box' && !(panel.value === 'properties' && transformOpen.value && selected.value?.visible)) {
    viewer?.boxTool(value => { box.value = value; });
    return;
  }
  const layer = selected.value;
  viewer?.edit(layer?.id ?? 0, panel.value === 'properties' && layer?.visible ? transformOpen.value : false, (value) => {
    if (layer) layer.transform = value;
  });
}
let base: GeoOrigin | undefined;
const hasBase = ref(false), mapLoaded = ref(false), mapBusy = ref(false);
const mapStatus = ref(''), attribution = ref('');
const lng = ref(116.3974), lat = ref(39.9093), altitude = ref(0);
const profileKey = 'gaussian-viewer.map-profile.v1';
function readProfile() {
  try { return JSON.parse(localStorage.getItem(profileKey) || 'null'); } catch { return null; }
}
const profile = readProfile();
interface SourceProfile extends MapOptions {
  endpoint: string; protocol: 'WMS' | 'WMTS'; terrain: 'default' | 'local' | 'WMS' | 'WMTS';
}
function defaults(provider: Provider): SourceProfile {
  return { provider, key:'', keyParameter:'key', elevationParameter:'key', imagery:true, labels:false, dem:false, heightOffset:0, endpoint:'',
    protocol:provider==='wms'?'WMS':'WMTS', demUrl:'', encoding:'terrarium',terrain:'default' };
}
const profiles: Partial<Record<Provider,SourceProfile>> = Object.fromEntries(
  Object.entries(profile?.sources || {}).filter(([id])=>Object.hasOwn(providers,id)),
);
if (profile && !profile.sources) {
  profiles.tianditu = { ...defaults('tianditu'), key:String(profile.key || ''), imagery:profile.imagery!==false && !(profile.provider==='osm' && !profile.key),
    labels:!!profile.labels && !!profile.key, dem:!!profile.dem, heightOffset:Number(profile.heightOffset)||0 };
}
const initial = profiles[profile?.active as Provider] || profiles.tianditu || defaults('tianditu');
const mapOptions = reactive<SourceProfile>({...initial});
const draft = ref<SourceProfile>({...initial});
function syncMeterValue(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  queueMicrotask(() => { input.nextElementSibling?.setAttribute('data-value', input.value); });
}
const catalog = ref<RasterLayer[]>([]);
const elevations = ref<RasterLayer[]>(initial.elevationLayer?[initial.elevationLayer]:[]);
const reading = ref(false), switching = ref(false);
let discovery: AbortController | undefined;
let selectionRevision = 0;
function resetCatalog(terrain=false) {
  discovery?.abort(); reading.value=false;
  if (terrain) { elevations.value=[]; draft.value.elevationLayer=undefined; return; }
  catalog.value=[]; draft.value.imageLayer=undefined; draft.value.labelLayer=undefined;
}
async function discover(terrain=false) {
  resetCatalog(terrain);
  const request = discovery = new AbortController();
  reading.value=true; mapStatus.value='';
  try {
    const endpoint=terrain ? draft.value.elevationEndpoint || '' : draft.value.endpoint;
    const available = await readMapService(endpoint,
      terrain ? draft.value.terrain==='WMS'?'WMS':'WMTS' : draft.value.protocol,request.signal,
      {endpoint,key:terrain?draft.value.elevationKey || '':draft.value.key,parameter:terrain?draft.value.elevationParameter || 'key':draft.value.keyParameter});
    if (request.signal.aborted) return;
    if (terrain) {
      elevations.value=available.filter(l=>l.format==='image/png');
      if (!elevations.value.length) throw Error('高程服务须提供无损 PNG 高程瓦片');
      draft.value.elevationLayer=elevations.value[0]; return;
    }
    catalog.value=available; draft.value.imageLayer=available[0]; draft.value.labels=false;
  } catch (error) { if (!request.signal.aborted) mapStatus.value=String(error); }
  finally { if (!request.signal.aborted) reading.value=false; }
}
function changeSource(provider: Provider) {
  ++selectionRevision;
  if (switching.value) { ++mapRevision; viewer?.cancelMapChange(); mapBusy.value=false; }
  discovery?.abort(); reading.value=false; switching.value=false;
  draft.value={...(profiles[provider] || defaults(provider))};
  elevations.value=draft.value.elevationLayer?[draft.value.elevationLayer]:[];
  catalog.value=[draft.value.imageLayer,draft.value.labelLayer].filter((v): v is RasterLayer=>!!v);
  mapStatus.value='';
  if (profiles[provider]) void saveProfile();
}
catalog.value=[initial.imageLayer,initial.labelLayer].filter((v): v is RasterLayer=>!!v);
const configured = ref(!!profiles[initial.provider]), expanded = ref(true), parentVisible = ref(true);
if (configured.value) layersOpen.value = true;
const mapLayers = computed(()=> ([
  {key:'imagery', name:'影像'}, {key:'labels', name:'注记'}, {key:'dem', name:'地形'},
] as const).filter(l=>l.key!=='labels'||mapOptions.provider==='tianditu'||!!mapOptions.labelLayer));
async function saveProfile() {
  const next={...draft.value,key:draft.value.key.trim()};
  if (next.provider==='tianditu' && !next.key && (next.imagery||next.labels)) { mapStatus.value='请输入天地图浏览器端 Key'; return; }
  if (next.provider!=='tianditu' && next.imagery && !next.imageLayer) { mapStatus.value='请读取地图服务并选择影像图层'; return; }
  next.labels=next.labels && (next.provider==='tianditu'||!!next.labelLayer);
  if (next.terrain==='default') next.demUrl='';
  if (next.terrain==='default') next.encoding='terrarium';
  if (next.terrain!=='WMS' && next.terrain!=='WMTS') next.elevationLayer=undefined;
  else if (next.dem && !next.elevationLayer) { mapStatus.value='请读取高程服务并选择图层'; return; }
  if (next.terrain==='local' && !['{z}','{x}','{y}'].every(token=>next.demUrl.includes(token))) { mapStatus.value='地形地址须包含 {z}、{x}、{y}'; return; }
  const revision=++selectionRevision;
  switching.value=true;
  try {
    if (!await applyMap(next) || revision!==selectionRevision) return;
    Object.assign(mapOptions,{imageLayer:undefined,labelLayer:undefined,elevationLayer:undefined},next);
    configured.value=layersOpen.value=true;
    profiles[next.provider]=next;
    try { localStorage.setItem(profileKey,JSON.stringify({active:next.provider,sources:profiles})); }
    catch { mapStatus.value='地图已切换，浏览器未允许保存配置'; }
  } finally { if(revision===selectionRevision) switching.value=false; }
}
let mapRevision = 0;
let mapWasVisible = false;
watch(parentVisible, () => {
  if (configured.value) void applyMap();
});
function toggleMapLayer(kind: 'imagery'|'labels'|'dem') {
  mapOptions[kind]=!mapOptions[kind];
  if (draft.value.provider===mapOptions.provider) draft.value[kind]=mapOptions[kind];
  void applyMap();
}
function rememberBase(origin: GeoOrigin) {
  const point = geographicPosition(origin);
  base = origin; hasBase.value = true;
  [lng.value, lat.value] = point; altitude.value = origin.offset[2];
  if (configured.value) void applyMap();
}
async function applyMap(settings: SourceProfile = mapOptions) {
  if (!viewer) return;
  mapStatus.value = '';
  if (settings.provider === 'tianditu' && parentVisible.value && (settings.imagery || settings.labels) && !settings.key.trim()) { mapStatus.value = '影像和注记需要天地图浏览器端 Key'; return; }
  if (![lng.value, lat.value, altitude.value, settings.heightOffset].every(Number.isFinite)) {
    mapStatus.value = '请填写场景原点的经纬度、高程和高度修正'; return;
  }
  const revision = ++mapRevision;
  mapBusy.value = true;
  try {
    await pending;
    if (revision !== mapRevision || lifetime.signal.aborted) return;
    const origin = base ?? { epsg: 4326, offset: [lng.value!, lat.value!, altitude.value!] as [number,number,number] };
    const options = { ...settings };
    if (!parentVisible.value) options.imagery = options.labels = options.dem = false;
    await viewer.loadMap(origin, options, value => { if (revision === mapRevision) mapStatus.value = value; });
    if (revision !== mapRevision) return;
    const visible = options.imagery || options.labels || options.dem;
    if (visible && !mapWasVisible) showGrid.value = false;
    mapWasVisible = visible;
    mapLoaded.value = layersOpen.value = true;
    attribution.value = [(options.imagery || options.labels) && providers[options.provider],
      options.dem && (options.terrain!=='default' ? '自定义 DEM' : 'DEM：Mapzen Terrain Tiles')].filter(Boolean).join(' · ');
    return true;
  } catch (error) { if (revision === mapRevision) mapStatus.value = String(error); }
  finally { if (revision === mapRevision) mapBusy.value = false; }
}
let controls: ReturnType<typeof mountViewControls> | undefined;
const worldLimitVisible = ref(false);
let limitTimer: ReturnType<typeof setTimeout>;
function showWorldLimit() {
  worldLimitVisible.value = true;
  clearTimeout(limitTimer);
  limitTimer = setTimeout(() => { worldLimitVisible.value = false; }, 2000);
}
onMounted(() => {
  controls = mountViewControls(viewport.value!, {
    direction: (value) => viewer?.direction(value),
    orbit: (x, y) => viewer?.orbit(x, y),
    projection: (o) => viewer?.projection(o),
  });
  try {
    viewer = new GaussianViewer(canvas.value!, viewport.value!, value => { stats.value = value; }, o => controls?.update(o), showWorldLimit);
    if (configured.value) void applyMap();
  } catch (error) { message.value = String(error); }
});
const showGrid = ref(true), showAxes = ref(true);
watch([showGrid, showAxes], ([grid, axes]) => {
  if (viewer) { viewer.showGrid = grid; viewer.showAxes = axes; }
});
const message = ref(''),
  stats = ref('');
const axis = ref(''),
  cut = ref(0);
const lifetime = new AbortController();
watch([panel, axis, selectedId, transformOpen, () => selected.value?.visible], updateTool);
const boxFields = [
  { key: 'translation', label: '中心（米）' },
  { key: 'rotation_degrees', label: '旋转（度）' },
  { key: 'scale', label: '尺寸（米）' },
] as const;
function changeSection() {
  if (axis.value === 'box' && viewer) box.value = viewer.initialSectionBox();
  viewer?.section(axis.value, cut.value, box.value);
}
function editBox(event: Event, key: keyof TransformParameters, index: number) {
  const input = event.target as HTMLInputElement;
  const value = input.valueAsNumber;
  if (Number.isFinite(value) && (key !== 'scale' || value > 0)) {
    box.value[key][index] = value;
    viewer?.section(axis.value, cut.value, box.value);
  } else input.value = String(box.value[key][index]);
}
let nextLayerId = 1;
const resources = new Map<number, { urls: string[]; controller: AbortController }>();
function releaseLayer(id: number) {
  const resource = resources.get(id);
  resource?.controller.abort();
  resource?.urls.forEach(url => URL.revokeObjectURL(url));
  resources.delete(id);
}
function unloadLayer(id: number) {
  const index = layers.findIndex(layer => layer.id === id);
  if (index < 0 || layers[index].loading) return;
  if (selectedId.value === id) {
    transformOpen.value = false;
    updateTool();
  }
  viewer?.removeLayer(id);
  releaseLayer(id);
  layers.splice(index, 1);
  if (selectedId.value === id) {
    selectedId.value = layers[Math.min(index, layers.length - 1)]?.id ?? 0;
    if (!selectedId.value && panel.value === 'properties') panel.value = undefined;
  }
}
let viewer: GaussianViewer | undefined;
let pending = Promise.resolve();
function positionLayer(layer: typeof layers[number], origin: GeoOrigin, reference = base ?? origin) {
  const translation = sceneOffset(origin, reference);
  let angle = 0, scale = 1;
  if (origin.epsg !== 4326 && origin.epsg !== reference.epsg) {
    const east = sceneOffset(
      { ...origin, offset: [origin.offset[0] + 1, origin.offset[1], origin.offset[2]] },
      reference,
    );
    const dx = east[0] - translation[0], dy = east[1] - translation[1];
    angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    scale = Math.hypot(dx, dy);
  }
  const next: TransformParameters = { translation, rotation_degrees: [0, 0, angle], scale: [scale, scale, 1] };
  if (layer.baseline) {
    for (let i = 0; i < 3; i++) {
      layer.transform.translation[i] += translation[i] - layer.baseline.translation[i];
      layer.transform.rotation_degrees[i] += next.rotation_degrees[i] - layer.baseline.rotation_degrees[i];
      layer.transform.scale[i] *= next.scale[i] / layer.baseline.scale[i];
    }
  } else layer.transform = structuredClone(next);
  layer.baseline = next;
  layer.origin = origin;
}
const shownOrigin = computed(() => {
  const layer = selected.value;
  if (!layer?.origin) return;
  const origin = layer.origin;
  if (!layer.projected) return convertOrigin(origin, 4326);
  return origin.epsg === 4326 ? convertOrigin(origin, wgs84Utm(origin.offset[0], origin.offset[1])) : origin;
});
const projectionLabel = computed(() => {
  const origin = selected.value?.origin;
  if (!origin) return '投影坐标参考系';
  const code = origin.epsg === 4326 ? wgs84Utm(origin.offset[0], origin.offset[1]) : origin.epsg;
  const zone = code % 100, series = Math.floor(code / 100);
  if ((series === 326 || series === 327) && zone >= 1 && zone <= 60)
    return `WGS 84 / UTM zone ${zone}${series === 326 ? 'N' : 'S'}`;
  return `投影坐标参考系（EPSG:${code}）`;
});
function editCoordinates() {
  const origin = shownOrigin.value;
  if (origin && selected.value) selected.value.originDraft = {
    epsg: String(origin.epsg), offset: origin.offset.map(String) as [string, string, string], message: '',
  };
}
async function readPlyFields(event: Event, layer: typeof layers[number]) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const draft = layer.originDraft;
  if (!file || !draft) return;
  try {
    const origin = await readOrigin(new Map([[file.name, file]]));
    if (!origin) throw Error('原始 PLY 文件头未提供有效 EPSG 和原点坐标');
    draft.epsg = String(origin.epsg);
    draft.offset = origin.offset.map(String) as [string, string, string];
    draft.message = '已读取坐标，核对后可应用';
  } catch (error) { draft.message = String(error); }
}
function applyLayerOrigin(layer: typeof layers[number]) {
  const draft = layer.originDraft;
  if (!viewer || !draft) return;
  try {
    const offset = draft.offset.map(Number) as GeoOrigin['offset'];
    const epsg = Number(draft.epsg);
    if (!Number.isInteger(epsg) || epsg <= 0 || draft.offset.some(v => !v.trim()) || !offset.every(Number.isFinite))
      throw Error('请填写有效的 EPSG 和三个原点坐标');
    const point = geographicPosition({ epsg, offset });
    if (!point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)
      throw Error('原点超出经纬度范围，请核对坐标系和单位');
    const origin = epsg === 4326 && layer.origin && layer.origin.epsg !== 4326
      ? convertOrigin({ epsg, offset }, layer.origin.epsg) : { epsg, offset };
    const establishBase = !base || (layers.length === 1 && !!layer.origin);
    positionLayer(layer, origin, establishBase ? origin : base);
    viewer.transform(layer.id, layer.transform);
    if (establishBase) rememberBase(origin);
    viewer.focusLayer(layer.id);
    layer.originDraft = undefined;
  } catch (error) { draft.message = String(error); }
}
async function open(
  files: File[],
  directory: boolean,
  paths = files.map((file) => file.webkitRelativePath || file.name),
) {
  if (!files.length) return;
  message.value = '';
  const id = nextLayerId++;
  const controller = new AbortController(), urls: string[] = [];
  resources.set(id, { controller, urls });
  layers.push({
    id,
    name: directory ? paths[0].split('/')[0] : files[0].name,
    visible: true,
    projected: false,
    status: '正在读取本地模型',
    loading: true,
    geo: '未确定地理原点',
    transform: { translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] },
  });
  layersOpen.value = true;
  selectLayer(id);
  const layer = layers[layers.length - 1];
  const previous = pending;
  let done!: () => void;
  pending = new Promise<void>((resolve) => {
    done = resolve;
  });
  await previous;
  try {
    lifetime.signal.throwIfAborted();
    let candidate: GeoOrigin | undefined;
    const entries = new Map(files.map((file, i) => [paths[i], file]));
    const model = await localModel(entries, urls, controller.signal, (origin) => {
      try {
        positionLayer(layer, origin);
        candidate = origin;
      } catch (error) {
        layer.geo = `${error} · 按本地原点显示`;
      }
    }, reason => { layer.geo = reason; });
    lifetime.signal.throwIfAborted();
    if (!viewer) throw new Error('三维视口初始化失败，请刷新页面重试');
    const loading = viewer.add(id, model, (value) => {
      layer.status = value;
    });
    viewer.visible(id, layer.visible);
    viewer.transform(id, layer.transform);
    await loading;
    if (viewer.loaded(id) && !candidate)
      layer.originDraft = { epsg: '4326', offset: ['', '', ''], message: '' };
    if (viewer.loaded(id) && candidate) {
      if (!base) rememberBase(candidate);
      if (layer.visible) viewer.focusLayer(id);
    }
    updateTool();
  } catch (error) {
    layer.status = String(error);
  } finally {
    layer.loading = false;
    done();
  }
}
async function choose(directory: boolean) {
  if (menu.value) menu.value.open = false;
  if (!directory) { filePicker.value?.click(); return; }
  try {
    const picked = await pickDirectory(() => directoryPicker.value?.click());
    if (picked) await open(picked.files, true, picked.paths);
  } catch (error) {
    message.value = String(error);
  }
}
async function drop(event: DragEvent) {
  const transfer = event.dataTransfer;
  if (!transfer || transfer.items.length !== 1) {
    message.value = '请一次拖入一个模型文件或一个完整目录';
    return;
  }
  const item = transfer.items[0];
  const file = item.getAsFile();
  if (item.webkitGetAsEntry?.()?.isDirectory) {
    try {
      const handle = await (
        item as DataTransferItem & {
          getAsFileSystemHandle?(): Promise<PickedDirectoryHandle>;
        }
      ).getAsFileSystemHandle?.();
      if (!handle) {
        message.value = '请使用「加载模型 → 选择文件夹」选择目录';
        return;
      }
      const files: File[] = [],
        paths: string[] = [];
      await collectDirectoryFiles(handle, handle.name, files, paths);
      await open(files, true, paths);
    } catch (error) {
      message.value = String(error);
    }
  } else if (file) await open([file], false);
}
function select(event: Event, directory: boolean) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  void open(files, directory);
}
onUnmounted(() => {
  discovery?.abort();
  clearTimeout(limitTimer);
  lifetime.abort();
  controls?.destroy();
  viewer?.destroy();
  for (const id of resources.keys()) releaseLayer(id);
});
</script>
<template>
  <main ref="viewport" class="viewer" @dragover.prevent @drop.prevent="drop">
    <canvas ref="canvas" tabindex="0" aria-label="高斯浏览场景" />
    <div class="bars">
      <div class="bar primary">
        <nav aria-label="当前位置"><RouterLink to="/">高斯视界</RouterLink><span aria-hidden="true">›</span><b>高斯浏览</b></nav>
        <details ref="menu" class="load" @keydown.esc="menu && (menu.open = false)"
          @focusout="event => { if (menu && !menu.contains(event.relatedTarget as Node)) menu.open = false; }">
          <summary><ViewerIcon name="folder" />加载模型<ViewerIcon name="down" /></summary>
          <div class="choices"><button @click="choose(false)">选择文件…</button><button @click="choose(true)">选择文件夹…</button></div>
        </details>
      </div>
      <div class="bar tools" role="group" aria-label="视图与面板">
        <button title="回中" @click="viewer?.fit()"><ViewerIcon name="center" />回中</button>
        <label class="projection"><ViewerIcon name="cube" /><select aria-label="视图" @change="viewer?.projection(($event.target as HTMLSelectElement).value === 'ortho')"><option>透视</option><option value="ortho">轴测</option></select></label>
        <i class="divider" aria-hidden="true" />
        <button :aria-expanded="panel === 'clip'" @click="togglePanel('clip')"><ViewerIcon name="clip" />剖切</button>
        <button :aria-expanded="panel === 'map'" @click="togglePanel('map')"><ViewerIcon name="map" />地图</button>
        <button :aria-expanded="layersOpen" @click="layersOpen = !layersOpen"><ViewerIcon name="layers" />图层</button>
        <button :aria-expanded="panel === 'settings'" @click="togglePanel('settings')"><ViewerIcon name="settings" />设置</button>
      </div>
    </div>
    <aside v-if="layersOpen || panel" class="dock">
      <section v-if="layersOpen" class="viewer-panel layer-panel" aria-label="图层">
        <header><h2>图层 <small>{{ layers.length + Number(configured) }}</small></h2><button aria-label="关闭图层" @click="layersOpen = false"><ViewerIcon name="close" /></button></header>
        <div class="layer-list">
          <div v-if="configured" class="map-group">
            <div class="layer-row"><button class="layer-name" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? '▾' : '▸' }} 地图</button>
              <button aria-label="显示地图" :title="parentVisible ? '隐藏' : '显示'" :aria-pressed="parentVisible" @click="parentVisible = !parentVisible"><ViewerIcon :name="parentVisible ? 'eye' : 'hidden'" /></button></div>
            <div v-if="expanded" class="map-children" role="group" aria-label="地图子图层">
              <div v-for="layer in mapLayers" :key="layer.key" class="layer-row">
                <span class="map-child-name">{{ layer.name }}</span>
                <button :aria-label="'显示' + layer.name" :aria-pressed="mapOptions[layer.key]" :title="mapOptions[layer.key] ? '隐藏' : '显示'" :disabled="!parentVisible" @click="toggleMapLayer(layer.key)"><ViewerIcon :name="mapOptions[layer.key] ? 'eye' : 'hidden'" /></button>
              </div>
            </div>
          </div>
          <p v-if="!layers.length && !configured" class="empty">尚未加载图层</p>
          <div v-for="layer in layers" :key="layer.id" class="layer-row" :aria-busy="layer.loading">
            <button class="layer-name" :aria-pressed="selectedId === layer.id" :title="layer.name" @click="selectLayer(layer.id)">
              <strong>{{ layer.name }}</strong><small v-if="layer.status">{{ layer.status }}</small>
            </button>
            <button type="button" :disabled="layer.loading" :aria-label="'卸载 ' + layer.name" title="卸载" @click="unloadLayer(layer.id)"><ViewerIcon name="unload" /></button>
            <button type="button" :disabled="layer.loading || !viewer?.loaded(layer.id)" :aria-label="'定位到 ' + layer.name"
              title="定位" @click="viewer?.focusLayer(layer.id)"><ViewerIcon name="locate" /></button>
            <button class="visibility" :aria-pressed="layer.visible" :aria-label="'显示 ' + layer.name" :title="layer.visible ? '隐藏' : '显示'"
              @click="layer.visible = !layer.visible; viewer?.visible(layer.id, layer.visible)"><ViewerIcon :name="layer.visible ? 'eye' : 'hidden'" /></button>
          </div>
        </div>
      </section>
      <section v-if="panel" class="viewer-panel" :aria-label="{properties:'模型属性',clip:'剖切',settings:'显示设置',map:'地图'}[panel]">
        <header><h2>{{ {properties:'模型属性',clip:'剖切',settings:'显示设置',map:'地图'}[panel] }}</h2>
          <button aria-label="关闭面板" @click="panel = undefined"><ViewerIcon name="close" /></button></header>
        <div class="panel-body">
          <form v-if="panel === 'map'" class="map-form" @submit.prevent="saveProfile">
            <label class="field">地图源<select aria-label="地图源" :value="draft.provider" @change="changeSource(($event.target as HTMLSelectElement).value as Provider)">
              <option v-for="(name,id) in providers" :key="id" :value="id">{{ name }}</option>
            </select></label>
            <label v-if="draft.provider==='tianditu'" class="field">服务 Key<input v-model="draft.key" type="password" autocomplete="off"></label>
            <template v-else>
              <label class="field">服务地址<input v-model.trim="draft.endpoint" placeholder="https://…/服务地址" @input="resetCatalog()"></label>
              <label class="field">服务 Key<input v-model="draft.key" type="password" autocomplete="off" placeholder="匿名服务可留空"></label>
              <label v-if="draft.key" class="field">Key 参数名<input v-model.trim="draft.keyParameter" required></label>
              <button type="button" :disabled="reading || !draft.endpoint" @click="discover()">{{ reading ? '正在读取…' : '读取服务图层' }}</button>
              <template v-if="catalog.length">
                <label class="field">影像图层<select aria-label="影像图层" v-model="draft.imageLayer"><option v-for="l in catalog" :key="l.id" :value="l">{{ l.title }}</option></select></label>
                <label class="field">注记图层<select aria-label="注记图层" v-model="draft.labelLayer"><option :value="undefined">无</option><option v-for="l in catalog" :key="l.id" :value="l">{{ l.title }}</option></select></label>
              </template>
            </template>
            <label class="toggle">影像<input v-model="draft.imagery" type="checkbox"></label>
            <label v-if="draft.provider==='tianditu'||draft.labelLayer" class="toggle">注记<input v-model="draft.labels" type="checkbox"></label>
            <label class="toggle">地形<input v-model="draft.dem" type="checkbox"></label>
            <template v-if="draft.dem">
              <label class="field">高程来源<select aria-label="高程来源" v-model="draft.terrain" @change="resetCatalog(true)"><option value="default">Mapzen Terrain Tiles</option><option value="local">本地 XYZ</option><option>WMS</option><option>WMTS</option></select></label>
              <label v-if="draft.terrain==='local'" class="field">地形地址<input v-model.trim="draft.demUrl" placeholder="/dem/{z}/{x}/{y}.png"></label>
              <template v-if="draft.terrain==='WMS'||draft.terrain==='WMTS'">
                <label class="field">高程服务<input v-model.trim="draft.elevationEndpoint" @input="resetCatalog(true)"></label>
                <label class="field">高程 Key<input v-model="draft.elevationKey" type="password" autocomplete="off" placeholder="匿名服务可留空"></label>
                <label v-if="draft.elevationKey" class="field">Key 参数名<input v-model.trim="draft.elevationParameter" required></label>
                <button type="button" :disabled="reading || !draft.elevationEndpoint" @click="discover(true)">读取高程图层</button>
                <label v-if="elevations.length" class="field">高程图层<select aria-label="高程图层" v-model="draft.elevationLayer"><option v-for="l in elevations" :key="l.id" :value="l">{{ l.title }}</option></select></label>
              </template>
              <label v-if="draft.terrain!=='default'" class="field">高程编码<select aria-label="高程编码" v-model="draft.encoding"><option value="terrarium">Terrarium</option><option value="terrain-rgb">Terrain-RGB</option></select></label>
            </template>
            <label class="field">经度<input v-model.number="lng" :disabled="hasBase" required type="number" step="any" min="-180" max="180"></label>
            <label class="field">纬度<input v-model.number="lat" :disabled="hasBase" required type="number" step="any" min="-85" max="85"></label>
            <label class="field">原点高程<span class="meter-field"><input v-model.number="altitude" @input="syncMeterValue" :disabled="hasBase" required type="number" step="any" aria-label="原点高程，单位米"><span aria-hidden="true" :data-value="altitude">m</span></span></label>
            <label class="field">高程修正<span class="meter-field"><input v-model.number="draft.heightOffset" @input="syncMeterValue" required type="number" step="any" aria-label="高程修正，单位米"><span aria-hidden="true" :data-value="draft.heightOffset">m</span></span></label>
            <button type="button" @click="saveProfile" :disabled="mapBusy || reading || switching">{{ mapBusy ? '正在读取瓦片…' : '保存地图配置' }}</button>
            <small role="status">{{ mapStatus }}</small>
          </form>
          <template v-if="panel === 'properties' && selected">
            <div class="field"><span>模型</span><b>{{ selected.name }}</b></div>
            <details :key="'coordinates-' + selected.id" class="coordinate-section" open>
              <summary>坐标</summary>
              <div v-if="shownOrigin && !selected.originDraft" class="map-form">
                <label class="field">坐标类型<select v-model="selected.projected" aria-label="坐标类型">
                  <option :value="false">WGS 84（地理坐标系）</option><option :value="true">{{ projectionLabel }}</option>
                </select></label>
                <div class="field"><span>EPSG</span><span>{{ shownOrigin.epsg }}</span></div>
                <div v-for="(v, i) in shownOrigin.offset" :key="i" class="field">
                  <span>{{ (selected.projected ? ['X', 'Y', '高程'] : ['经度', '纬度', '高程'])[i] }}</span>
                  <span>{{ Number(v.toFixed(selected.projected || i === 2 ? 4 : 8)) }}{{ !selected.projected && i < 2 ? '°' : ' m' }}</span>
                </div>
                <button type="button" class="apply-origin" @click="editCoordinates">修改坐标</button>
              </div>
              <small v-else-if="!selected.origin">{{ selected.geo }}</small>
            <form v-if="selected.originDraft" :key="selected.id" class="map-form" @submit.prevent="applyLayerOrigin(selected)">
              <label class="field">EPSG<input v-model="selected.originDraft.epsg" required inputmode="numeric" placeholder="如 32651 或 4326" /></label>
              <label v-for="(axisName, i) in ['X', 'Y', 'Z']" :key="axisName" class="field">
                {{ Number(selected.originDraft.epsg) === 4326 ? ['经度（度）', '纬度（度）', '原点高程（米）'][i] : '原点 ' + axisName }}
                <input v-model="selected.originDraft.offset[i]" required inputmode="decimal" />
              </label>
              <label class="field">PLY 读取<input type="file" accept=".ply" @change="readPlyFields($event, selected)" /></label>
              <button type="submit" class="apply-origin">应用坐标</button>
              <button v-if="selected.origin" type="button" class="cancel-origin" @click="selected.originDraft = undefined">取消修改</button>
              <small v-if="selected.originDraft.message" role="status">{{ selected.originDraft.message }}</small>
            </form>
            </details>
            <TransformEditor heading="变换" collapsible-matrix @expanded="transformOpen = $event" :key="selected.id" :model="selected.name" :model-value="selected.transform" :reset-value="selected.baseline"
              @update:model-value="value => { if (selected) { selected.transform = value; viewer?.transform(selected.id, value); } }" />
          </template>
          <template v-if="panel === 'clip'">
            <label class="field">剖切方式<select v-model="axis" @change="changeSection">
              <option value="">关闭</option><option v-for="a in ['x','y','z']" :key="a" :value="a">{{ a.toUpperCase() }} 轴</option><option value="box">旋转剖切盒</option></select></label>
            <template v-if="axis === 'box'">
              <div v-for="field in boxFields" :key="field.key" class="box-fields">
                <span>{{ field.label }}</span>
                <label v-for="(dim,i) in ['X','Y','Z']" :key="dim">{{ dim }}
                  <input type="number" step="any" :aria-label="field.label + dim" :value="box[field.key][i]" @change="editBox($event, field.key, i)" />
                </label>
              </div>
            </template>
            <label v-else-if="axis" class="field">剖切位置<input v-model.number="cut" type="number" @change="viewer?.section(axis, cut, box)" /></label>
          </template>
          <template v-if="panel === 'settings'">
            <label class="toggle">XOY 平面网格<input v-model="showGrid" type="checkbox" /></label>
            <label class="toggle">XYZ 坐标轴<input v-model="showAxes" type="checkbox" /></label>
          </template>
        </div>
      </section>
    </aside>
    <div class="view-gizmo viewer-gizmo" aria-label="快速视角"><ViewportCube /></div>
    <input ref="filePicker" hidden type="file" accept=".ply,.spz,.sog,.zip" @change="select($event, false)" />
    <input ref="directoryPicker" hidden type="file" webkitdirectory multiple @change="select($event, true)" />
    <div v-if="worldLimitVisible" class="world-limit" role="status">已缩放至全球范围</div>
    <footer><span role="status">{{ message || (layers.find(l => l.status === '正在读取本地模型') ? '正在读取本地模型' : '') || stats || '可拖入本地模型文件或文件夹' }}</span>
      <span v-if="mapLoaded && parentVisible">{{ attribution }}</span>
      <span class="guide">WASD 移动 · 左键环绕 · 右键平移 · 滚轮缩放</span></footer>
  </main>
</template>
<style scoped src="./viewer.css"></style>
