<script setup lang="ts">
import type { RegistrationSession } from '../../api/contracts';
import ViewportToolbar from './ViewportToolbar.vue';
import type { ToolbarCommand, ToolbarState } from './toolbar-state';
import type { GaussianViewState } from './gaussian-view-state';
import type { ResultViewState } from './result-view-state';
import RegistrationResultPanel from './RegistrationResultPanel.vue';
import type { InspectorState } from './inspector-state';

defineProps<{ session: RegistrationSession; gaussian: GaussianViewState; toolbar: ToolbarState; result: ResultViewState; inspector: InspectorState }>();
const emit = defineEmits<{ toolbar: [command: ToolbarCommand] }>();
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
  style: { '--cx': x, '--cy': y, '--cz': z },
  title: `等轴视角 ${x > 0 ? '+' : '−'}X ${y > 0 ? '+' : '−'}Y ${z > 0 ? '+' : '−'}Z`,
}))));
</script>

<template>
  <main class="editor integrated-editor">
    <header class="workbench-topbar">
      <div class="workbench-brand"><span>R</span><small>REGISTRATION STUDIO</small></div>
      <div class="workflow-title">
        <div><h1>通用点云双向配准</h1><small>A：{{ session.metadata!.models.a.format.toUpperCase() }}　B：{{ session.metadata!.models.b.format.toUpperCase() }}</small></div>
        <button id="new-task">新建</button>
      </div>
    </header>
    <div class="workspace integrated-workspace">
      <aside class="panel workflow-panel">
        <header class="dock-heading"><span>01</span><div><strong>模型与坐标</strong><small>确认输入数据和业务场景矩阵</small></div></header>
        <section class="workflow-step completed">
          <h2><span>1</span> 模型</h2>
          <p>A：{{ session.metadata!.models.a.source_point_count.toLocaleString() }} 点<br>B：{{ session.metadata!.models.b.source_point_count.toLocaleString() }} 点</p>
          <p id="badge" class="model-role-summary"></p>
          <div id="business-transform-panel"></div>
          <p id="gaussian-status" class="gaussian-status" :class="{ error: gaussian.error }" :hidden="!gaussian.message">{{ gaussian.message }}</p>
        </section>
      </aside>
      <section class="viewport">
        <canvas id="viewport"></canvas>
        <ViewportToolbar :session="session" :gaussian="gaussian" :state="toolbar" @command="emit('toolbar', $event)" />
        <div id="iteration-progress" class="viewport-progress" :class="{ completed: result.progressCompleted }" :style="{ top: `${result.progressTop}px` }"
          role="status" aria-live="polite" :hidden="!result.progressVisible">{{ result.progressText }}</div>
        <div class="view-gizmo" aria-label="快速视角">
          <div class="view-cube-scene"><div class="view-cube">
            <button v-for="face in faces" :key="face.axis" class="cube-face" :class="`face-${face.axis}`" :data-direction="face.direction" :title="face.title">{{ face.label }}</button>
            <button v-for="corner in corners" :key="corner.direction" class="cube-corner" :data-direction="corner.direction" :style="corner.style" :title="corner.title"></button>
          </div></div>
          <div class="projection-switch"><button data-projection="orthographic">正交</button><button data-projection="perspective" class="active">透视</button></div>
        </div>
        <div id="viewport-help" class="viewport-help">左键空白：旋转　中键：平移　滚轮：缩放　左键平移轴／面：移动模型　左键旋转圆环：旋转模型</div>
      </section>
      <aside class="inspector-panel">
        <header class="dock-heading"><span>02</span><div><strong>工具与配准</strong><small>视图工具、粗配准姿态与 ICP 参数</small></div></header>
        <section id="clipping-panel" class="clipping-panel inspector-tool" :hidden="!inspector.clipping"></section>
        <section class="origin-planes-panel inspector-tool" :hidden="!inspector.originPlanes"></section>
        <section class="coordinate-panel inspector-tool" :hidden="!inspector.query"></section>
        <section v-show="!inspector.clipping && !inspector.originPlanes && !inspector.query" class="workflow-step registration-inspector">
          <h2><span>2</span> 方向与粗配准</h2>
          <div id="registration-roles"></div><div id="coarse-pose-form"></div>
          <details><summary>初始 moving-local→fixed-local</summary><pre id="initial-matrix" class="matrix"></pre></details>
        </section>
        <section v-show="!inspector.clipping && !inspector.originPlanes && !inspector.query" class="workflow-step registration-inspector"><h2><span>3</span> ICP 参数</h2><div id="icp-parameters"></div><div id="registration-actions-host"></div></section>
      </aside>
      <section class="result-drawer">
        <section class="workflow-step">
          <h2><span>4</span> 结果</h2><pre id="job-status" class="status timeline">{{ result.status }}</pre>
          <section id="result" class="result" :hidden="!result.visible">
            <RegistrationResultPanel :result="result.result" :direction="result.direction" />
          </section>
        </section>
      </section>
    </div>
  </main>
</template>
