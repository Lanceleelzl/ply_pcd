import { createWorkbenchLifecycle } from '../app/workbench-lifecycle';
import { initializeWorkbench, type WorkbenchHost } from '../app/workbench-runtime';
import '../workspace.css';
import '../view-gizmo.css';

export async function renderGenericRegistration(
  root: HTMLElement,
  sessionId: string,
  host: WorkbenchHost,
): Promise<() => void> {
  const externalSignal = host.signal;
  externalSignal?.throwIfAborted();
  const lifecycle = createWorkbenchLifecycle(externalSignal);
  const { signal, resources, dispose } = lifecycle;
  try {
    await initializeWorkbench(root, sessionId, signal, resources, host);
    signal.throwIfAborted();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
