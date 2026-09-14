import { waitForSession } from '../api/registration-api.ts';
import { loadPreview, type PreviewCloud } from '../point-cloud.ts';
import type { RegistrationSession } from '../api/contracts';

export interface WorkbenchLoadedSession {
  session: RegistrationSession;
  previews: { a: PreviewCloud; b: PreviewCloud };
}

export async function loadWorkbenchSession(sessionId: string, signal: AbortSignal, onStatus: (status: string) => void): Promise<WorkbenchLoadedSession> {
  const session = await waitForSession(sessionId, signal, onStatus);
  const [a, b] = await Promise.all([
    loadPreview(session.model_a_preview_url!, signal),
    loadPreview(session.model_b_preview_url!, signal),
  ]);
  signal.throwIfAborted();
  return { session, previews: { a, b } };
}
