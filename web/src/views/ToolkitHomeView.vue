<script setup lang="ts">
import { useWorkspaceStore } from '../stores/workspace-store';

const workspace = useWorkspaceStore();
</script>

<template>
  <main class="toolkit-home">
    <div class="toolkit-home-content">
      <div class="toolkit-home-heading">
        <span>GAUSSIAN VISION</span>
        <h1>高斯视界</h1>
        <p>解决一切高斯问题。</p>
      </div>
      <div class="toolkit-grid">
        <RouterLink class="toolkit-card" to="/registration">
          <h2>视界转换</h2>
          <p>支持两个具有点云性质的数据世界，通过粗配准→ICP 精配准建立矩阵转换关系，获取双向矩阵或同一位置的对应坐标。</p>
          <strong>进入工具 <span aria-hidden="true">→</span></strong>
        </RouterLink>
        <RouterLink class="toolkit-card" to="/streaming">
          <h2>高斯流式数据处理</h2>
          <p>支持导入高斯模型或已有的LOD文件组，生成高斯流式数据，可以预览对应的点云/高斯模型，打包下载处理后的流式数据。</p>
          <strong>进入工具 <span aria-hidden="true">→</span></strong>
        </RouterLink>
        <RouterLink class="toolkit-card" to="/merge">
          <h2>高斯合并</h2>
          <p>对齐多个高斯模型，在俯视图绘制重叠取舍与删减范围，逐层合并 PLY，并按需生成流式数据。</p>
          <strong>进入工具 <span aria-hidden="true">→</span></strong>
        </RouterLink>
      </div>
      <small class="toolkit-workspace">当前工作区：{{ workspace.workspaceId.slice(0, 8) }}</small>
    </div>
  </main>
</template>

<style scoped>
.toolkit-home { min-height: 100vh; padding: clamp(40px, 8vw, 100px) 24px; background: radial-gradient(circle at 50% 0, #193651 0, #08111d 65%); color: #edf5ff; }
.toolkit-home-content { width: min(1040px, 100%); margin: 0 auto; }
.toolkit-home-heading { margin-bottom: 34px; }
.toolkit-home-heading > span { color: #78d6b8; font: 700 12px ui-monospace, Consolas, monospace; letter-spacing: .08em; }
.toolkit-home-heading h1 { margin: 16px 0 10px; font-size: clamp(32px, 5vw, 48px); }
.toolkit-home-heading p { margin: 0; color: #adbed2; }
.toolkit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.toolkit-card { display: flex; flex-direction: column; gap: 18px; min-height: 320px; padding: 32px; border: 1px solid #385574; border-radius: 18px; background: linear-gradient(145deg, #17283d, #0c1928); color: inherit; text-decoration: none; transition: border-color .18s, transform .18s; }
.toolkit-card:hover { border-color: #78d6b8; transform: translateY(-3px); }
.toolkit-card h2 { margin: 0; font-size: 27px; }
.toolkit-card p { max-width: 32em; margin: 0; color: #adbed2; line-height: 1.65; }
.toolkit-card strong { display: flex; justify-content: space-between; margin-top: auto; color: #78d6b8; }
.toolkit-workspace { display: block; margin-top: 22px; color: #7489a2; }
@media (max-width: 720px) { .toolkit-grid { grid-template-columns: 1fr; } .toolkit-card { min-height: 260px; } }
</style>
