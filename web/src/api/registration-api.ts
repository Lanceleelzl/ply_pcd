import type { CreateSessionInput, HistoryItem } from './contracts';

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
