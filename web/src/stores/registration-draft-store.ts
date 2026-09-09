import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { createSession } from '../api/registration-api';
import type { ModelId, OutputDirection } from '../api/contracts';
import type { TransformParameters } from '../coordinate-math';

const defaultTransform = (): TransformParameters => ({
  translation: [0, 0, 0],
  rotation_degrees: [0, 0, 0],
  scale: [1, 1, 1],
});

const validateTransform = (transform: TransformParameters): void => {
  const values = [...transform.translation, ...transform.rotation_degrees, ...transform.scale];
  if (values.some(value => !Number.isFinite(value))) throw new Error('预变换参数必须是有效数字');
  if (transform.scale.some(value => value <= 0)) throw new Error('缩放必须大于 0');
};

export const useRegistrationDraftStore = defineStore('registration-draft', () => {
  const files = reactive<Record<ModelId, File | undefined>>({ a: undefined, b: undefined });
  const transforms = reactive<Record<ModelId, TransformParameters>>({
    a: defaultTransform(),
    b: defaultTransform(),
  });
  const outputDirection = ref<OutputDirection>('a_to_b');
  const movingModel = ref<'auto' | ModelId>('auto');
  const submitting = ref(false);
  const status = ref('');

  const submit = async (workspaceId: string): Promise<string | undefined> => {
    if (submitting.value) return;
    if (!files.a || !files.b) {
      status.value = '请先选择模型 A 和模型 B。';
      return;
    }
    submitting.value = true;
    try {
      validateTransform(transforms.a);
      validateTransform(transforms.b);
      status.value = '正在上传：0%';
      const sessionId = await createSession({
        modelA: files.a,
        modelB: files.b,
        modelATransform: transforms.a,
        modelBTransform: transforms.b,
        outputDirection: outputDirection.value,
        movingModel: movingModel.value,
        workspaceId,
      }, percent => { status.value = `正在上传：${percent}%`; });
      status.value = '上传完成，正在生成点云预览……';
      return sessionId;
    } catch (reason) {
      status.value = `创建失败：${String(reason)}`;
      return undefined;
    } finally {
      submitting.value = false;
    }
  };

  return { files, transforms, outputDirection, movingModel, submitting, status, submit };
});
