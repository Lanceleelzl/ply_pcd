<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useBackgroundCacheStore, type CacheTask } from '../stores/background-cache-store';
const store = useBackgroundCacheStore();
onMounted(() => store.start());
const visibleTasks = computed(() => store.tasks.slice(0, 8));
const statusText = (task: CacheTask): string => ({ queued: '等待后台槽位',
  converting: task.progress === null ? '正在生成流式缓存' : `正在生成 ${task.progress}%`,
  ready: '流式缓存已完成', failed: '生成失败' }[task.status]);
</script>

<template>
  <details class="background-task-center">
    <summary><i :class="{ active: store.activeCount > 0 }" />后台任务 <b v-if="store.activeCount">{{ store.activeCount }}</b></summary>
    <div class="background-task-popover">
      <header><strong>后台任务</strong><button type="button" :disabled="store.refreshing" @click.prevent="store.refresh">刷新</button></header>
      <p v-if="!visibleTasks.length && !store.copcJobs.length" class="background-task-empty">当前没有任务。</p>
      <article v-for="job in store.copcJobs.slice(0,8)" :key="job.id" class="background-task-row" :class="job.status">
        <div><strong>{{ job.name }}</strong><small>LAS → COPC</small></div>
        <span>{{ {queued:'等待转换', converting:'正在转换', ready:'转换完成', failed:'转换失败'}[job.status] }}</span>
        <small v-if="job.error" class="background-task-error">{{ job.error }}</small>
      </article>
      <article v-for="task in visibleTasks" :key="task.key" class="background-task-row" :class="task.status">
        <div><strong>{{ task.label }}</strong><small>{{ task.format }} · {{ task.sessionId.slice(0, 8) }}</small></div>
        <span><i v-if="task.status === 'converting' && task.progress === null" />{{ statusText(task) }}</span>
        <progress v-if="task.progress !== null" max="100" :value="task.progress" />
        <small v-if="task.error" class="background-task-error">{{ task.error }}</small>
      </article>
      <footer>缓存任务在后台运行，不影响当前配准。</footer>
    </div>
  </details>
</template>
