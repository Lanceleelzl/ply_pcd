<script setup lang="ts">
import type { RegistrationSession } from '../../api/contracts';

const props = defineProps<{ session: RegistrationSession }>();
const models = ['a', 'b'] as const;
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
const gaussianUrl = (model: 'a' | 'b') => props.session[`gaussian_${model}_url`];
const gaussianTitle = (model: 'a' | 'b') => {
  const bytes = props.session.inputs?.[`model_${model}_bytes`];
  const size = bytes ? `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : '大小未知';
  return gaussianUrl(model)
    ? `加载模型 ${model.toUpperCase()} 原始 Gaussian（${size}）`
    : `模型 ${model.toUpperCase()} 不包含完整 Gaussian 属性`;
};
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
          <p id="gaussian-status" class="gaussian-status" hidden></p>
        </section>
      </aside>
      <section class="viewport">
        <canvas id="viewport"></canvas>
        <div class="viewport-toolbar toolbar">
          <div class="viewport-tool-group" role="group" aria-label="配准与视图">
            <span class="tool-group-label">配准与视图</span>
            <button id="reset" title="清除当前移动模型的平移和旋转，恢复到模型刚加载时的位置">重置</button>
            <button id="fit">适应全部</button>
            <button id="clipping-toggle">剖切</button>
          </div>
          <div class="viewport-tool-group" role="group" aria-label="模型显隐">
            <span class="tool-group-label">模型显隐</span>
            <button v-for="model in models" :id="`toggle-model-${model}`" :key="model" class="active">{{ model.toUpperCase() }}：显示</button>
          </div>
          <div class="viewport-tool-group" role="group" aria-label="高斯显示">
            <span class="tool-group-label">高斯显示</span>
            <button v-for="model in models" :id="`gaussian-model-${model}`" :key="model" class="gaussian-toggle" :class="{ available: gaussianUrl(model) }" :disabled="!gaussianUrl(model)" :title="gaussianTitle(model)">{{ model.toUpperCase() }}：高斯</button>
          </div>
          <div class="viewport-tool-group" role="group" aria-label="平面工具">
            <span class="tool-group-label">平面工具</span><button id="origin-planes-toggle" aria-pressed="false">原点平面</button>
          </div>
          <div class="viewport-tool-group" role="group" aria-label="坐标工具">
            <span class="tool-group-label">坐标工具</span>
            <button id="coordinate-query" disabled title="完成 ICP 后可查询坐标对">坐标查询</button>
            <button id="origin-a" aria-pressed="false">A 原点／轴</button><button id="origin-b" aria-pressed="false">B 原点／轴</button>
          </div>
        </div>
        <div id="iteration-progress" class="viewport-progress" role="status" aria-live="polite" hidden></div>
        <section id="clipping-panel" class="clipping-panel" hidden></section>
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
        <header class="dock-heading"><span>02</span><div><strong>配准检查器</strong><small>粗配准姿态与 ICP 参数</small></div></header>
        <section class="workflow-step">
          <h2><span>2</span> 方向与粗配准</h2>
          <div id="registration-roles"></div><div id="coarse-pose-form"></div>
          <details><summary>初始 moving-local→fixed-local</summary><pre id="initial-matrix" class="matrix"></pre></details>
        </section>
        <section class="workflow-step"><h2><span>3</span> ICP 参数</h2><div id="icp-parameters"></div><div id="registration-actions-host"></div></section>
      </aside>
      <section class="result-drawer">
        <section class="workflow-step"><h2><span>4</span> 结果</h2><pre id="job-status" class="status timeline">尚未提交</pre><section id="result" class="result" hidden></section></section>
      </section>
    </div>
  </main>
</template>
