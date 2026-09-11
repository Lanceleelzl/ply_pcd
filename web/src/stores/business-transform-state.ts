import { reactive } from 'vue';
import { saveBusinessTransforms } from '../api/registration-api.ts';
import type { ModelId } from '../api/contracts';
import type { TransformParameters, XYZ } from '../coordinate-math';

export type BusinessTransforms = Record<ModelId, TransformParameters>;

export const defaultBusinessTransform = (): TransformParameters => ({
  translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1],
});

const toDraft = (value: TransformParameters) => ({
  translation: value.translation.map(String),
  rotation_degrees: value.rotation_degrees.map(String),
  scale: value.scale.map(String),
});

export function createBusinessTransformState(
  sessionId: string,
  initial: BusinessTransforms,
  signal: AbortSignal,
  applied: (transforms: BusinessTransforms) => void,
) {
  const drafts = reactive({ a: toDraft(initial.a), b: toDraft(initial.b) });
  const state = reactive({ disabled: false, saving: false, message: '' });
  const read = (model: ModelId): TransformParameters => {
    const values = (kind: keyof TransformParameters) => drafts[model][kind].map(value =>
      value.trim() === '' ? (kind === 'scale' ? 1 : 0) : Number(value)) as XYZ;
    const next = { translation: values('translation'), rotation_degrees: values('rotation_degrees'), scale: values('scale') };
    if (Object.values(next).flat().some(value => !Number.isFinite(value))) throw new Error('参数必须是有效数字');
    if (next.scale.some(value => value <= 0)) throw new Error('缩放必须大于 0');
    return next;
  };
  const apply = async () => {
    if (signal.aborted || state.disabled || state.saving) return;
    state.saving = true;
    try {
      const next = { a: read('a'), b: read('b') };
      await saveBusinessTransforms(sessionId, next, signal);
      signal.throwIfAborted();
      applied(next);
      state.message = '已应用。视图已按各模型预变换更新，粗配准及旧 ICP 结果已失效，请重新配准。';
    } catch (error) {
      if (!signal.aborted) state.message = `应用失败：${String(error)}`;
    } finally {
      state.saving = false;
    }
  };
  const reset = () => {
    if (signal.aborted || state.disabled || state.saving) return;
    drafts.a = toDraft(defaultBusinessTransform());
    drafts.b = toDraft(defaultBusinessTransform());
  };
  return { drafts, state, apply, reset };
}
