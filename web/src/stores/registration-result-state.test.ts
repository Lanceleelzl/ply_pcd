import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityMatrix } from '../coordinate-math.ts';
import type { RegistrationIteration, RegistrationResult } from '../api/contracts';
import { createRegistrationResultState } from './registration-result-state.ts';

const result: RegistrationResult = {
  recommended_matrix: { name: 'a_to_b', formula: 'p_b = M * p_a', value: identityMatrix() },
  moving_model: 'a', moving_local_to_fixed_local: identityMatrix(),
  a_to_b: identityMatrix(), b_to_a: identityMatrix(),
  metrics: { final_rms: 0.123456789, final_point_count: 50000, elapsed_seconds: 12.345 },
};
const iteration: RegistrationIteration = {
  type: 'iteration', iteration: 8, rms: 0.25, point_count: 1000,
  elapsed_seconds: 2.5, moving_local_to_fixed_local: identityMatrix(),
};

test('pose changes invalidate results without resurrecting them when the pose returns', () => {
  const results = createRegistrationResultState();
  results.show(result, 'b_to_a', 'pose-a');
  results.invalidateIfChanged('pose-a');
  assert.equal(results.state.visible, true);
  assert.equal(results.state.direction, 'b_to_a');
  assert.equal(results.state.result, result);
  results.invalidateIfChanged('pose-b');
  assert.equal(results.state.visible, false);
  results.invalidateIfChanged('pose-a');
  assert.equal(results.state.visible, false);
});

test('new registration clears old completion and progress while hiding previous matrices', () => {
  const results = createRegistrationResultState();
  results.show(result, 'a_to_b', 'pose');
  results.updateProgress(iteration);
  results.complete(result, true);
  results.begin(false);
  assert.equal(results.state.visible, false);
  assert.equal(results.state.progressCompleted, false);
  assert.equal(results.state.progressVisible, false);
  assert.equal(results.state.progressText, '');
  results.setProgressVisible(true, true);
  assert.equal(results.state.progressText, '正在读取当前 ICP 进度……');
});

test('progress visibility preserves received iteration and does not alter the result matrix', () => {
  const results = createRegistrationResultState();
  results.begin(true);
  assert.equal(results.state.progressText, '等待首轮 ICP 结果……');
  results.updateProgress(iteration);
  const text = results.state.progressText;
  assert.match(text, /第 8 轮.*0\.250000/);
  results.setProgressVisible(false, true);
  results.setProgressVisible(true, true);
  assert.equal(results.state.progressText, text);
  assert.equal(results.state.result, null);
});

test('success without received iterations remains completed after toggling progress', () => {
  for (const visibleAtCompletion of [true, false]) {
    const results = createRegistrationResultState();
    results.begin(visibleAtCompletion);
    results.show(result, 'a_to_b', 'pose');
    results.complete(result, visibleAtCompletion);
    results.setProgressVisible(false, false);
    results.setProgressVisible(true, false);
    assert.equal(results.state.progressCompleted, true);
    assert.match(results.state.progressText, /本次匹配已完成.*0\.123457/);
    assert.equal(results.state.visible, true);
  }
});

test('result state belongs to a single workbench instance', () => {
  const first = createRegistrationResultState();
  const second = createRegistrationResultState();
  first.show(result, 'b_to_a', 'pose');
  first.complete(result, true);
  assert.equal(second.state.result, null);
  assert.equal(second.state.visible, false);
  assert.equal(second.state.progressCompleted, false);
  assert.equal(second.state.status, '尚未提交');
});
