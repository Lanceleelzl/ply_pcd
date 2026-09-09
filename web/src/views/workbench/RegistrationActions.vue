<script setup lang="ts">
defineProps<{ running: boolean; locked: boolean; cancelling: boolean; progress: boolean }>();
const emit = defineEmits<{ run: []; cancel: []; progress: [visible: boolean] }>();
</script>

<template>
  <label class="progress-option">
    <input id="show-registration-progress" type="checkbox" :checked="progress" :disabled="locked"
      @change="emit('progress', ($event.target as HTMLInputElement).checked)">
    在三维场景中显示配准过程
  </label>
  <div class="registration-actions">
    <button id="register" class="primary" :class="{ running }" :disabled="running || locked"
      :title="locked ? '请先返回配准编辑，再执行 ICP' : ''" @click="emit('run')">
      {{ running ? 'ICP 配准中' : '执行 ICP 精配准' }}
    </button>
    <button v-if="running" id="cancel-registration" class="cancel-action" :disabled="cancelling" @click="emit('cancel')">
      {{ cancelling ? '正在终止…' : '终止任务' }}
    </button>
  </div>
</template>
