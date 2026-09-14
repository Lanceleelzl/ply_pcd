import type { ModelId, RegistrationSession } from '../api/contracts';
import type { TransformParameters } from '../coordinate-math';
import type { XYZ } from '../coordinate-math';

export interface WorkbenchSessionContext {
  session: RegistrationSession;
  models: NonNullable<RegistrationSession['metadata']>['models'];
  businessTransforms: Record<ModelId, TransformParameters>;
  gaussianUrls: Record<ModelId, string | undefined>;
  origins: Record<ModelId, XYZ>;
}

function cloneTransform(value: TransformParameters): TransformParameters {
  return {
    translation: [...value.translation] as [number, number, number],
    rotation_degrees: [...value.rotation_degrees] as [number, number, number],
    scale: [...value.scale] as [number, number, number],
  };
}

export function createWorkbenchSessionContext(session: RegistrationSession): WorkbenchSessionContext {
  if (!session.metadata) throw new Error('会话缺少模型元数据');
  const defaultTransform = (): TransformParameters => ({
    translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1],
  });
  const transforms = session.business_transforms ?? { a: defaultTransform(), b: defaultTransform() };
  return {
    session,
    models: session.metadata.models,
    businessTransforms: { a: cloneTransform(transforms.a), b: cloneTransform(transforms.b) },
    gaussianUrls: { a: session.gaussian_a_url, b: session.gaussian_b_url },
    origins: { a: session.metadata.models.a.origin as XYZ, b: session.metadata.models.b.origin as XYZ },
  };
}
