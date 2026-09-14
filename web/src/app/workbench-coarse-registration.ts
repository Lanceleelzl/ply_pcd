import { reactive } from 'vue';
import type { CoarseRegistrationResult, Matrix4, ModelId } from '../api/contracts.ts';
import { CoarseRegistrationController } from '../engine/modules/CoarseRegistrationController.ts';

interface CoarseDisplayPort {
  getMovingLocalToFixedLocal(): Matrix4;
  setMovingLocalToFixedLocal(matrix: Matrix4): void;
  getPose(): { position: [number, number, number]; rotation: [number, number, number] };
}

export function createWorkbenchCoarseRegistration(options: {
  sessionId: string;
  signal: AbortSignal;
  movingModel(): ModelId;
  display: CoarseDisplayPort;
  setRunning(value: boolean): void;
  updatePose(values: number[]): void;
  invalidateResult(): void;
  fitCamera(): void;
}) {
  const state = reactive({
    running: false,
    status: '',
    result: null as CoarseRegistrationResult | null,
    previewed: -1,
    accepted: -1,
    adjusted: false,
  });
  let original: Matrix4 | null = null;
  const apply = (index: number) => {
    const candidate = state.result?.candidates[index];
    if (!candidate) return;
    options.display.setMovingLocalToFixedLocal(candidate.moving_local_to_fixed_local);
    const pose = options.display.getPose();
    options.updatePose([...pose.position, ...pose.rotation]);
    options.invalidateResult();
    options.fitCamera();
    state.previewed = index;
  };
  const controller = new CoarseRegistrationController({
    runningChanged: running => { state.running = running; options.setRunning(running); },
    statusChanged: status => { state.status = status; },
    succeeded: result => {
      state.result = result;
      state.previewed = -1;
      state.accepted = -1;
      state.adjusted = false;
      state.status = `找到 ${result.candidates.length} 个候选，结果尚未应用`;
    },
  }, options.signal);
  return {
    state,
    actions: {
      run: async () => {
        original = options.display.getMovingLocalToFixedLocal();
        state.result = null; state.previewed = -1; state.accepted = -1; state.adjusted = false;
        try { await controller.run(options.sessionId, options.movingModel()); }
        catch (error) { state.status = `自动粗配准失败：${error instanceof Error ? error.message : String(error)}`; }
      },
      cancel: () => controller.cancel(),
      preview: apply,
      accept: (index: number) => {
        apply(index);
        state.accepted = index;
        state.adjusted = false;
        state.status = '已采用候选；仍可使用手柄或数值继续调整，再执行 ICP';
      },
      discard: () => {
        if (original) {
          options.display.setMovingLocalToFixedLocal(original);
          const pose = options.display.getPose();
          options.updatePose([...pose.position, ...pose.rotation]);
          options.invalidateResult();
          options.fitCamera();
        }
        state.result = null; state.previewed = -1; state.accepted = -1; state.adjusted = false;
        state.status = '已放弃自动候选并恢复原姿态';
      },
    },
    initialSource: () => state.accepted < 0 ? 'manual' : state.adjusted ? '4pcs_adjusted' : '4pcs',
    markAdjusted: () => {
      if (state.accepted >= 0) {
        state.adjusted = true;
        state.status = '已采用自动候选并进行手动调整';
      }
    },
    reset: () => {
      state.result = null; state.previewed = -1; state.accepted = -1; state.adjusted = false; original = null;
    },
    destroy: () => controller.destroy(),
  };
}
