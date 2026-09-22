<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RegistrationSession } from '../../api/contracts';
import ViewportToolbar from './ViewportToolbar.vue';
import type { ToolbarCommand, ToolbarState } from './toolbar-state';
import type { GaussianViewState } from './gaussian-view-state';
import type { ResultViewState } from './result-view-state';
import RegistrationResultPanel from './RegistrationResultPanel.vue';
import type { InspectorState } from './inspector-state';
import BackgroundTaskCenter from '../../components/BackgroundTaskCenter.vue';

const props = defineProps<{ view: { roleSummary: string; initialMatrix: string; help: string }; session: RegistrationSession; gaussian: GaussianViewState; toolbar: ToolbarState; result: ResultViewState; inspector: InspectorState }>();
const emit = defineEmits<{ newTask: []; toolbar: [command: ToolbarCommand] }>();
const viewport = ref<HTMLElement | null>(null);
const progressTop = ref(0);
const resultOpen = ref(false);
const inspectorOpen = computed(() => props.inspector.clipping || props.inspector.originPlanes || props.inspector.query);
let progressResize: ResizeObserver | undefined;
const positionProgress = () => {
  const toolbar = viewport.value?.querySelector<HTMLElement>('.viewport-toolbar');
  if (toolbar) progressTop.value = toolbar.offsetTop + toolbar.offsetHeight + 8;
};
onMounted(() => {
  const toolbar = viewport.value!.querySelector<HTMLElement>('.viewport-toolbar')!;
  progressResize = new ResizeObserver(positionProgress);
  progressResize.observe(toolbar);
  positionProgress();
});
watch(() => props.result.progressVisible, positionProgress, { flush: 'post' });
onBeforeUnmount(() => progressResize?.disconnect());
const faces = [
  { axis: 'x', direction: '1,0,0', label: 'X', title: '沿 +X 查看' },
  { axis: 'nx', direction: '-1,0,0', label: '−X', title: '沿 -X 查看' },
  { axis: 'y', direction: '0,1,0', label: 'Y', title: '沿 +Y 查看' },
  { axis: 'ny', direction: '0,-1,0', label: '−Y', title: '沿 -Y 查看' },
  { axis: 'z', direction: '0,0,1', label: 'Z', title: '顶视图（沿 +Z 查看）' },
  { axis: 'nz', direction: '0,0,-1', label: '−Z', title: '底视图（沿 -Z 查看）' },
];
const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => ({
  direction: `${x},${y},${z}`,
  title: `斜视角 ${x > 0 ? '+' : '−'}X ${y > 0 ? '+' : '−'}Y ${z > 0 ? '+' : '−'}Z`,
}))));
</script>

<template>
  <main class="editor integrated-editor">
    <header class="workbench-topbar">
      <div class="workbench-brand"><span>R</span><small>REGISTRATION STUDIO</small></div>
      <div class="workflow-title">
        <div class="workbench-title-text">
          <h1>通用点云双向配准</h1>
          <div class="workbench-model-names">
            <small v-for="model in (['a', 'b'] as const)" :key="model" :title="session.inputs?.[`model_${model}_original_filename`]">
              {{ model.toUpperCase() }}：<template v-if="session.inputs?.[`model_${model}_original_filename`]">{{ session.inputs[`model_${model}_original_filename`] }}（{{ session.metadata!.models[model].format.toUpperCase() }}）</template><template v-else>{{ session.metadata!.models[model].format.toUpperCase() }}</template>
            </small>
          </div>
        </div>
        <div class="workbench-header-actions"><BackgroundTaskCenter /><button id="new-task" @click="emit('newTask')">新建</button></div>
      </div>
    </header>
    <div class="workspace integrated-workspace" :class="{ 'has-inspector': inspectorOpen }">
      <aside class="panel workflow-panel">
        <header class="dock-heading"><strong>配准流程</strong></header>
        <section class="workflow-step completed">
          <h2><span>1</span> 模型与坐标</h2>
          <p>A：{{ session.metadata!.models.a.source_point_count.toLocaleString() }} 点<br>B：{{ session.metadata!.models.b.source_point_count.toLocaleString() }} 点</p>
          <p id="badge" class="model-role-summary">{{ view.roleSummary }}</p>
          <div id="business-transform-panel"><slot name="business" /></div>
          <p id="gaussian-status" class="gaussian-status" :class="{ error: gaussian.error }" :hidden="!gaussian.message">{{ gaussian.message }}</p>
        </section>
        <section class="workflow-step">
          <h2><span>2</span> 方向与粗配准</h2>
          <button id="reset" class="coarse-reset" :disabled="toolbar.locked" @click="emit('toolbar', { type: 'reset' })">重置粗配准</button><div id="registration-roles"><slot name="roles" /></div><div id="coarse-pose-form"><slot name="pose" /></div>
          <details><summary>初始 moving-local→fixed-local</summary><pre id="initial-matrix" class="matrix">{{ view.initialMatrix }}</pre></details>
        </section>
        <section class="workflow-step"><h2><span>3</span> ICP 精配准</h2><details><summary>ICP 参数</summary><div id="icp-parameters"><slot name="icp" /></div></details><div id="registration-actions-host"><slot name="actions" /></div></section>
        <section class="workflow-step result-summary">
          <h2><span>4</span> 配准结果</h2>
          <pre id="job-status" class="status timeline">{{ result.status }}</pre>
          <p v-if="result.visible && result.result">RMS：{{ result.result.metrics.final_rms.toFixed(6) }} m</p>
          <button type="button" :disabled="!result.visible" :aria-expanded="resultOpen" @click="resultOpen = !resultOpen">{{ resultOpen ? '收起结果矩阵' : '查看结果与复制矩阵' }}</button>
          <section id="result" v-show="resultOpen && result.visible" class="result result-column">
            <RegistrationResultPanel :result="result.result" :direction="result.direction" />
          </section>
        </section>
      </aside>
      <section ref="viewport" class="viewport">
        <canvas id="viewport"></canvas>
        <ViewportToolbar :session="session" :gaussian="gaussian" :state="toolbar" @command="emit('toolbar', $event)" />
        <div id="iteration-progress" class="viewport-progress" :class="{ completed: result.progressCompleted }" :style="{ top: `${progressTop}px` }"
          role="status" aria-live="polite" :hidden="!result.progressVisible">{{ result.progressText }}</div>
        <div class="view-gizmo" aria-label="快速视角">
          <div class="view-cube-scene"><div class="view-cube-scale"><div class="view-cube">
            <button v-for="face in faces" :key="face.axis" class="cube-face" :class="`face-${face.axis}`" :data-direction="face.direction" :title="face.title">{{ face.label }}</button>
            <button v-for="corner in corners" :key="corner.direction" class="cube-corner" :data-direction="corner.direction" :title="corner.title"><span v-for="facet in 4" :key="facet" class="cube-corner-facet" aria-hidden="true"></span></button>
          </div></div></div>
          <div class="projection-switch"><button data-projection="orthographic">正交</button><button data-projection="perspective" class="active">透视</button></div>
        </div>
        <div id="viewport-help" class="viewport-help">{{ view.help }}</div>
      </section>
      <aside v-show="inspectorOpen" class="inspector-panel">
        <section id="clipping-panel" class="clipping-panel inspector-tool" :hidden="!inspector.clipping"><slot name="clipping" /></section>
        <section class="origin-planes-panel inspector-tool" :hidden="!inspector.originPlanes"><slot name="originPlanes" /></section>
        <section class="coordinate-panel inspector-tool" :hidden="!inspector.query"><slot name="query" /></section>
      </aside>
    </div>
  </main>
</template>
