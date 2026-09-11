import { loadRegistrationResult } from '../api/registration-api.ts';
import type { Matrix4, ModelId, RegistrationResult, RegistrationSession } from '../api/contracts';
import { identityMatrix } from '../coordinate-math.ts';

type HistoryRegistration = NonNullable<RegistrationSession['registrations']>[number];

interface HistoryRestoreContext {
  signature(): string;
  running(): boolean;
  businessMatrices: Record<ModelId, Matrix4>;
  apply(result: RegistrationResult, registration: HistoryRegistration): void;
  unavailable(): void;
}

export async function restoreRegistrationHistory(
  registrations: RegistrationSession['registrations'],
  signal: AbortSignal,
  context: HistoryRestoreContext,
): Promise<void> {
  const latest = registrations?.at(-1);
  if (signal.aborted || latest?.status !== 'succeeded' || !latest.result_url) return;
  const signature = context.signature();
  const current = () => !signal.aborted && signature === context.signature() && !context.running();
  try {
    const result = await loadRegistrationResult(latest.result_url, signal);
    signal.throwIfAborted();
    const matching = result.coordinate_space === 'business' && (['a', 'b'] as ModelId[]).every(model => {
      const matrix = result.business_transforms?.[model].matrix ?? identityMatrix();
      return matrix.flat().every((value, index) => Math.abs(value - context.businessMatrices[model].flat()[index]) < 1e-12);
    });
    if (matching && current()) context.apply(result, latest);
  } catch {
    if (current()) context.unavailable();
  }
}
