import { ResourceScope } from './resource-scope.ts';

export function createWorkbenchLifecycle(parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const resources = new ResourceScope();
  const dispose = () => {
    controller.abort();
    parentSignal?.removeEventListener('abort', dispose);
    try { resources.dispose(); } catch (error) { console.error(error); }
  };
  if (parentSignal?.aborted) dispose();
  else parentSignal?.addEventListener('abort', dispose, { once: true });
  return { signal: controller.signal, resources, dispose };
}
