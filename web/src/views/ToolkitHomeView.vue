<script setup lang="ts">
import { useWorkspaceStore } from '../stores/workspace-store';

const workspace = useWorkspaceStore();
</script>

<template>
  <main class="toolkit-home">
    <div class="toolkit-home-content">
      <div class="toolkit-home-heading">
        <span>GAUSSIAN TOOLKIT</span>
        <h1>高斯数据工具箱</h1>
        <p>选择要处理的任务。每项工具都有独立的操作流程和任务历史。</p>
      </div>
      <div class="toolkit-grid">
        <RouterLink class="toolkit-card" to="/registration">
          <span class="toolkit-card-number">01 ／ 坐标处理</span>
          <h2>ICP 配准</h2>
          <p>使用两个模型建立坐标转换关系，获取双向矩阵和同一位置的对应坐标。</p>
          <div><span>输入两份数据</span><span>矩阵与坐标</span></div>
          <strong>进入工具 <span aria-hidden="true">→</span></strong>
        </RouterLink>
        <RouterLink class="toolkit-card" to="/streaming">
          <span class="toolkit-card-number">02 ／ 流式处理</span>
          <h2>高斯流式数据处理</h2>
          <p>导入高斯模型或已有 LOD 文件组，预览模型，生成并下载流式数据。</p>
          <div><span>输入一份数据或层级组</span><span>流式缓存</span></div>
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
.toolkit-home-heading > span, .toolkit-card-number { color: #78d6b8; font: 700 12px ui-monospace, Consolas, monospace; letter-spacing: .08em; }
.toolkit-home-heading h1 { margin: 16px 0 10px; font-size: clamp(32px, 5vw, 48px); }
.toolkit-home-heading p { margin: 0; color: #adbed2; }
.toolkit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.toolkit-card { display: flex; flex-direction: column; gap: 18px; min-height: 320px; padding: 32px; border: 1px solid #385574; border-radius: 18px; background: linear-gradient(145deg, #17283d, #0c1928); color: inherit; text-decoration: none; transition: border-color .18s, transform .18s; }
.toolkit-card:hover { border-color: #78d6b8; transform: translateY(-3px); }
.toolkit-card h2 { margin: 0; font-size: 27px; }
.toolkit-card p { max-width: 32em; margin: 0; color: #adbed2; line-height: 1.65; }
.toolkit-card > div { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; }
.toolkit-card > div span { padding: 6px 10px; border: 1px solid #385574; border-radius: 999px; color: #c7d9ea; font-size: 12px; }
.toolkit-card strong { display: flex; justify-content: space-between; color: #78d6b8; }
.toolkit-workspace { display: block; margin-top: 22px; color: #7489a2; }
@media (max-width: 720px) { .toolkit-grid { grid-template-columns: 1fr; } .toolkit-card { min-height: 260px; } }
</style>
