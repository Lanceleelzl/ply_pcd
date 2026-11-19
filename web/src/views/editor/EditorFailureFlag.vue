<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ reason: string }>();
const expanded = ref(false);
watch(() => props.reason, () => { expanded.value = false; });
</script>

<template>
  <button type="button" class="failure-flag" :aria-expanded="expanded"
    :aria-label="expanded ? '收起失败原因' : '查看失败原因'" :title="expanded ? '收起失败原因' : '查看失败原因'"
    @click="expanded = !expanded"><span aria-hidden="true">!</span></button>
  <span v-if="expanded" class="failure-detail">{{ reason }}</span>
</template>

<style scoped>
button.failure-flag[type="button"] {
  display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: 50%; background: transparent; vertical-align: middle;
}
.failure-flag span {
  display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%;
  background: #ba2836; color: white; font: bold 14px/1 sans-serif;
}
.failure-detail { display: block; max-height: 12rem; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
</style>
