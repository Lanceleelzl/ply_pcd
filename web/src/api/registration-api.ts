import type { CreateSessionInput, HistoryItem, RegistrationResult, RegistrationSession } from './contracts';
import type { ModelId } from './contracts';
import type { TransformParameters } from '../coordinate-math';

export async function loadRegistrationResult(url: string, signal: AbortSignal): Promise<RegistrationResult> {
  signal.throwIfAborted();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json() as RegistrationResult;
  signal.throwIfAborted();
  return result;
}

export async function saveBusinessTransforms(
  sessionId: string,
  transforms: Record<ModelId, TransformParameters>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const response = await fetch(`/api/v2/registration-sessions/${encodeURIComponent(sessionId)}/business-transforms`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_a: transforms.a, model_b: transforms.b }), signal,
  });
  const body = await responseBody(response);
  signal.throwIfAborted();
  if (!response.ok) throw new Error(String(body.detail ?? `HTTP ${response.status}`));
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForSession(
  sessionId: string,
  signal: AbortSignal,
  onStatus: (status: string) => void,
): Promise<RegistrationSession> {
  while (true) {
    signal.throwIfAborted();
    const response = await fetch(`/api/v2/registration-sessions/${encodeURIComponent(sessionId)}`, { signal });
    const body = await responseBody(response);
    signal.throwIfAborted();
    if (!response.ok) throw new Error(String(body.detail ?? `HTTP ${response.status}`));
    if (typeof body.status !== 'string') throw new Error('会话响应缺少预览状态');
    const session = body as unknown as RegistrationSession;
    onStatus(session.status);
    if (session.status === 'ready') return session;
    if (session.status === 'failed') throw new Error(session.error ?? '预览生成失败');
    await waitForPoll(signal);
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function listHistory(workspaceId: string): Promise<HistoryItem[]> {
  const response = await fetch(`/api/v2/registration-history?workspace_id=${encodeURIComponent(workspaceId)}`);
  const body = await responseBody(response);
  if (!response.ok) throw new Error(String(body.detail ?? `HTTP ${response.status}`));
  return (body.items ?? []) as HistoryItem[];
}

export async function runSessionAction(sessionId: string, action: 'retain' | 'release' | 'resume', workspaceId: string): Promise<void> {
  const response = await fetch(`/api/v2/registration-sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  const body = await responseBody(response);
  if (!response.ok) throw new Error(String(body.detail ?? `HTTP ${response.status}`));
}

export function createSession(input: CreateSessionInput, onProgress: (percent: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/v2/registration-sessions');
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    });
    request.addEventListener('load', () => {
      let body: { session_id?: string; detail?: string } = {};
      try { body = JSON.parse(request.responseText || '{}') as typeof body; } catch { /* handled below */ }
      if (request.status >= 200 && request.status < 300 && body.session_id) resolve(body.session_id);
      else reject(new Error(body.detail ?? `HTTP ${request.status}`));
    });
    request.addEventListener('error', () => reject(new Error('网络连接失败')));

    const data = new FormData();
    data.append('model_a', input.modelA);
    data.append('model_b', input.modelB);
    data.append('output_direction', input.outputDirection);
    data.append('moving_model', input.movingModel);
    data.append('workspace_id', input.workspaceId);
    data.append('model_a_transform', JSON.stringify(input.modelATransform));
    data.append('model_b_transform', JSON.stringify(input.modelBTransform));
    request.send(data);
  });
}
