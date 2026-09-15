<script setup lang="ts">
import { computed } from 'vue';
import type { ModelId, OutputDirection } from '../../api/contracts';
const props = defineProps<{
  moving: 'auto' | ModelId; direction: OutputDirection; recommended: ModelId;
  diagonals: Record<ModelId, number>; disabled: boolean;
}>();
const emit = defineEmits<{ moving: [value: 'auto' | ModelId]; direction: [value: OutputDirection] }>();
const movingModel = computed(() => props.moving === 'auto' ? props.recommended : props.moving);
const fixedModel = computed(() => movingModel.value === 'a' ? 'b' : 'a');
const ratio = computed(() => props.diagonals[fixedModel.value] > 0
  ? props.diagonals[movingModel.value] / props.diagonals[fixedModel.value] : Infinity);
</script>

<template>
  <div class="role-grid">
    <label class="parameter-label">转换方向<select id="output-direction" :value="direction" :disabled="disabled"
      @change="emit('direction', ($event.target as HTMLSelectElement).value as OutputDirection)">
      <option value="a_to_b">模型 A → 模型 B</option><option value="b_to_a">模型 B → 模型 A</option>
    </select></label>
    <label class="parameter-label">ICP 移动模型<select id="moving-model" :value="moving" :disabled="disabled"
      @change="emit('moving', ($event.target as HTMLSelectElement).value as 'auto' | ModelId)">
      <option value="auto">自动推荐（{{ recommended.toUpperCase() }}）</option><option value="a">移动模型 A</option><option value="b">移动模型 B</option>
    </select></label>
  </div>
  <p id="role-hint" class="step-hint" title="预览与粗配准均使用业务坐标；数值为移动模型业务局部坐标 → 固定模型业务局部坐标。">ICP：移动 {{ movingModel.toUpperCase() }}，固定 {{ fixedModel.toUpperCase() }} · 业务坐标</p>
  <p id="range-risk" class="range-risk" :hidden="ratio < 1.25">范围风险：移动模型 {{ movingModel.toUpperCase() }} 的包围盒对角线约为固定模型 {{ fixedModel.toUpperCase() }} 的 {{ ratio.toFixed(1) }} 倍。大范围点云匹配小范围点云容易落入错误位置；建议改为移动 {{ fixedModel.toUpperCase() }} 匹配 {{ movingModel.toUpperCase() }}。最终业务方向无需改变，系统返回的反向矩阵就是所需转换矩阵。</p>
</template>
