import { apiFetch } from './api-auth';
import type { TransformParameters, XYZ } from '../coordinate-math';

export type StreamingInputKind = 'single' | 'dataset' | 'lod_group';
export type StreamingState = 'queued' | 'preparing' | 'ready' | 'failed';
export type CacheState = 'not_requested' | 'queued' | 'converting' | 'ready' | 'failed';

export interface StreamingLod {
  level: number;
  name: string;
  path: string;
  bytes: number;
  sha256: string;
  format: string;
  gaussian_url: string;
}

export interface StreamingTask {
  task_id: string;
  workspace_id: string;
  input_kind: StreamingInputKind;
  filename: string;
  format: string;
  status: StreamingState;
  cache_status: CacheState;
  cache_progress: number | null;
  cache_error?: string | null;
  error?: string;
  business_transform: TransformParameters;
  metadata?: { format: string; source_point_count: number; preview_point_count: number;
    origin: XYZ; bounds: { min: XYZ; max: XYZ } };
  preview_url?: string;
  gaussian_url?: string;
  gaussian_filename?: string;
  cache_url?: string;
  lods?: StreamingLod[];
  created_at_unix: number;
  source_expires_at_unix: number | null;
  source_available?: boolean;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
  return body;
}

export async function createStreamingTask(input: {
  kind: StreamingInputKind;
  workspaceId: string;
  file?: File;
  files?: File[];
  paths?: string[];
  transform: TransformParameters;
}): Promise<StreamingTask> {
  const form = new FormData();
  form.set('input_kind', input.kind);
  form.set('workspace_id', input.workspaceId);
  form.set('business_transform', JSON.stringify(input.transform));
  if (input.file) form.set('file', input.file);
  input.files?.forEach((file, index) => {
    const path = input.paths?.[index];
    form.append('files', file, path ?? file.name);
  });
  return jsonResponse<StreamingTask>(await apiFetch('/api/v2/streaming-tasks', { method: 'POST', body: form }));
}

export async function listStreamingTasks(workspaceId: string): Promise<StreamingTask[]> {
  return jsonResponse<StreamingTask[]>(await apiFetch(
    `/api/v2/streaming-tasks?workspace_id=${encodeURIComponent(workspaceId)}`));
}

export async function loadStreamingTask(taskId: string): Promise<StreamingTask> {
  return jsonResponse<StreamingTask>(await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(taskId)}`));
}

export async function saveStreamingTransform(taskId: string, value: TransformParameters): Promise<StreamingTask> {
  return jsonResponse<StreamingTask>(await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(taskId)}/business-transform`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  }));
}

export async function generateStreamedCache(taskId: string): Promise<StreamingTask> {
  return jsonResponse<StreamingTask>(await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(taskId)}/generate`, {
    method: 'POST',
  }));
}

export async function retainStreamingSource(taskId: string): Promise<StreamingTask> {
  return jsonResponse<StreamingTask>(await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(taskId)}/retain`, { method: 'POST' }));
}

export async function releaseStreamingSource(taskId: string): Promise<StreamingTask> {
  return jsonResponse<StreamingTask>(await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(taskId)}/release`, { method: 'POST' }));
}

interface WritableHandle {
  createWritable(): Promise<{ write(value: Uint8Array): Promise<void>; close(): Promise<void>; abort(error?: unknown): Promise<void> }>;
}

export async function downloadStreamingCache(
  taskId: string,
  filename: string,
  options: { handle?: WritableHandle; onHandle?(value: WritableHandle): void;
    onProgress?(received: number, total: number): void } = {},
): Promise<WritableHandle> {
  const picker = (window as typeof window & {
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<WritableHandle>;
  }).showSaveFilePicker;
  if (!options.handle && !picker) throw new Error('当前浏览器不支持流式保存，请使用 Chrome 或 Edge');
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const safeName = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'model';
  const handle = options.handle ?? await picker!({ suggestedName: `${safeName}-streamed-sog-${stamp}.zip` });
  options.onHandle?.(handle);
  const response = await apiFetch(`/api/v2/streaming-tasks/${encodeURIComponent(taskId)}/download`);
  if (!response.ok) throw new Error((await response.json() as { detail?: string }).detail ?? `HTTP ${response.status}`);
  if (!response.body) throw new Error('下载响应不支持流式读取');
  const total = Number(response.headers.get('X-Cache-Source-Bytes')) || 0;
  const reader = response.body.getReader();
  let writable: Awaited<ReturnType<WritableHandle['createWritable']>> | undefined;
  let received = 0;
  try {
    writable = await handle.createWritable();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      options.onProgress?.(received, total);
    }
    await writable.close();
    return handle;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    await writable?.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
