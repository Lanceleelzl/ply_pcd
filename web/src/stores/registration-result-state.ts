import { shallowReactive } from 'vue';
import type { OutputDirection, RegistrationIteration, RegistrationResult } from '../api/contracts';
import type { ResultViewState } from '../views/workbench/result-view-state';

export function createRegistrationResultState() {
  const state = shallowReactive<ResultViewState>({
    result: null, direction: 'a_to_b', visible: false, status: '尚未提交',
    progressVisible: false, progressCompleted: false, progressText: '',
  });
  let resultSignature = '';
  let latestProgressIteration = 0;
  const hide = () => { state.visible = false; resultSignature = ''; };
  return {
    state,
    hide,
    invalidateIfChanged(signature: string) {
      if (resultSignature && resultSignature !== signature) hide();
    },
    show(result: RegistrationResult, direction: OutputDirection, signature: string) {
      resultSignature = signature;
      state.direction = direction;
      state.result = result;
      state.visible = true;
    },
    begin(progressVisible: boolean) {
      hide();
      latestProgressIteration = 0;
      state.progressCompleted = false;
      state.progressVisible = progressVisible;
      state.progressText = progressVisible ? '等待首轮 ICP 结果……' : '';
    },
    updateProgress(progress: RegistrationIteration) {
      latestProgressIteration = progress.iteration;
      state.progressText = `第 ${progress.iteration} 轮　RMS ${progress.rms.toFixed(6)} m　${progress.point_count.toLocaleString()} 点　${progress.elapsed_seconds.toFixed(2)} s`;
    },
    complete(result: RegistrationResult, progressVisible: boolean) {
      state.progressVisible = progressVisible;
      state.progressCompleted = true;
      state.progressText = `本次匹配已完成　RMS ${result.metrics.final_rms.toFixed(6)} m　${result.metrics.final_point_count.toLocaleString()} 点　${result.metrics.elapsed_seconds.toFixed(2)} s`;
      state.status = '配准完成。';
    },
    setProgressVisible(visible: boolean, running: boolean) {
      state.progressVisible = visible;
      if (visible && !state.progressCompleted && latestProgressIteration === 0) {
        state.progressText = running ? '正在读取当前 ICP 进度……' : '已开启过程显示，等待执行 ICP。';
      }
    },
  };
}
