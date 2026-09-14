<script setup lang="ts">
import type { CoarseRegistrationResult } from '../../api/contracts';
defineProps<{
  running: boolean;
  disabled: boolean;
  status: string;
  result: CoarseRegistrationResult | null;
  previewed: number;
  accepted: number;
}>();
const emit = defineEmits<{
  run: [];
  cancel: [];
  preview: [index: number];
  accept: [index: number];
  discard: [];
}>();
const riskText = (risk: CoarseRegistrationResult['risk']) => ({
  none: '候选证据较充分，仍需人工确认',
  low_confidence: '候选证据不足，建议手动检查或放弃',
  ambiguous: '多个候选接近，存在几何歧义',
}[risk]);
</script>

<template>
  <section class="auto-coarse">
    <div class="auto-coarse-heading"><strong>4PCS 自动粗配准</strong><small>可选候选，不替代手动调整</small></div>
    <button v-if="!running" type="button" :disabled="disabled" @click="emit('run')">搜索候选</button>
    <button v-else type="button" class="danger" @click="emit('cancel')">取消搜索</button>
    <p v-if="status" class="step-hint" role="status">{{ status }}</p>
    <template v-if="result">
      <p class="coarse-risk" :class="result.risk">{{ riskText(result.risk) }}</p>
      <ol class="coarse-candidates">
        <li v-for="(candidate, index) in result.candidates" :key="`${candidate.overlap}-${candidate.random_seed}`">
          <span>#{{ index + 1 }}　评分 {{ candidate.score.toFixed(3) }}　覆盖 {{ (Math.min(candidate.moving_coverage, candidate.fixed_coverage) * 100).toFixed(1) }}%</span>
          <span class="candidate-actions">
            <button type="button" :class="{ active: previewed === index }" @click="emit('preview', index)">预览</button>
            <button type="button" :disabled="accepted === index" @click="emit('accept', index)">{{ accepted === index ? '已采用' : '采用' }}</button>
          </span>
        </li>
      </ol>
      <button type="button" @click="emit('discard')">放弃候选并恢复</button>
    </template>
  </section>
</template>
