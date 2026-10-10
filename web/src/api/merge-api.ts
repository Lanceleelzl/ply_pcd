import { apiFetch } from './api-auth';

export type RegionAction = 'none' | 'remove_inside' | 'remove_outside';
export type Region = { kind: 'per_model'; actions: RegionAction[]; polygon: [number, number][] };
export type LegacyRegion = { kind: 'keep' | 'remove'; model: number; polygon: [number, number][] }
  | { kind: 'clip' | 'select'; models: number[]; side: 'inside' | 'outside'; polygon: [number, number][] };
export type ModelCoordinates = { epsg: string; offset: [string, string, string]; confirmed: boolean };
export type MergeModelSetting = { axes: number[]; unit: 'm' | 'cm' | 'mm'; scale: number; confirmed: boolean };
export type MergeTask = {
  task_id: string; models: ({ lods: { name: string; count: number }[]; epsg: string; offset: number[] | null; source?: string; correction: number[]; rotation?: number[] } & Partial<MergeModelSetting>)[];
  regions: (Region | LegacyRegion)[]; axes: number[]; units_confirmed: boolean; target_model?: number;
  merge_status: string; merge_error?: string; cache_status: string; cache_error?: string;
  level_progress?: { level: number; status: string; processed: number; total: number; error?: string }[];
  selected_levels?: number[];
  merged_lods?: { level: number; count: number; by_model: number[] }[];
};
export type MergeOrigin = { epsg: string; projected: number[] | null; wgs84: number[] | null };

export async function previewMergeCoordinates(epsg: string, offset: string[]): Promise<number[]> {
  const query = new URLSearchParams({ epsg, x: offset[0], y: offset[1], z: offset[2] });
  const result = await json<{ wgs84: number[] }>(await apiFetch(`/api/v2/gaussian-merges/coordinate-preview?${query}`));
  return result.wgs84;
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
  return body;
}

export async function createMerge(workspace: string, models: File[][],
  targetModel: number,
  coordinates: ModelCoordinates[]): Promise<MergeTask> {
  const form = new FormData();
  form.set('workspace', workspace);
  form.set('model_levels', JSON.stringify(models.map(model => model.length)));
  form.set('target_model', String(targetModel));
  form.set('model_coordinates', JSON.stringify(coordinates));
  models.forEach(model => model.forEach(file => form.append('files', file)));
  return json<MergeTask>(await apiFetch('/api/v2/gaussian-merges', { method: 'POST', body: form }));
}

export async function loadMerge(id: string): Promise<MergeTask> {
  return json<MergeTask>(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}`));
}

export async function listMerges(workspace: string): Promise<MergeTask[]> {
  return json<MergeTask[]>(await apiFetch(`/api/v2/gaussian-merges?workspace=${encodeURIComponent(workspace)}`));
}

export async function loadMergePreview(id: string, level?: number): Promise<{ models: number[][][] }> {
  return json(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/preview${level === undefined ? '' : `?level=${level}`}`));
}

export function mergeLodUrl(id: string, level: number, model: number): string {
  return `/api/v2/gaussian-merges/${encodeURIComponent(id)}/lod/${level}/${model}`;
}

export async function loadMergedPreview(id: string, level: number): Promise<{ models: number[][][] }> {
  return json(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/preview-merged/${level}`));
}

export async function saveMergeRegions(id: string, regions: Region[], corrections: number[][], rotations: number[][],
  axes: number[], unitsConfirmed: boolean, targetModel: number, modelSettings?: MergeModelSetting[]): Promise<MergeTask> {
  return json<MergeTask>(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/regions`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regions, corrections, rotations, axes, units_confirmed: unitsConfirmed, target_model: targetModel,
      ...(modelSettings ? { model_settings: modelSettings } : {}) }),
  }));
}

export async function loadMergeOrigin(id: string): Promise<MergeOrigin> {
  return json<MergeOrigin>(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/origin`));
}
export async function saveMergeOrigin(id: string, epsg: string, mode: 'projected' | 'wgs84', values: number[]): Promise<MergeOrigin> {
  return json<MergeOrigin>(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/origin`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epsg, mode, values }),
  }));
}
export async function resetMergeOrigin(id: string): Promise<MergeOrigin> {
  return json<MergeOrigin>(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/origin`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'reset' }),
  }));
}
export async function startMerge(id: string, operation: 'merge' | 'generate', levels?: number[]): Promise<MergeTask> {
  return json<MergeTask>(await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/${operation}`, {
    method: 'POST', ...(operation === 'merge' ? {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levels }),
    } : {}),
  }));
}

export async function downloadMerge(id: string, kind: 'ply' | 'streamed', onProgress: (bytes: number) => void): Promise<void> {
  const picker = (window as typeof window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable(): Promise<{ write(value: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
  }> }).showSaveFilePicker;
  if (!picker) throw new Error('请使用支持流式保存的 Chrome 或 Edge');
  const handle = await picker({ suggestedName: `gaussian-merge-${kind}.zip` });
  const response = await apiFetch(`/api/v2/gaussian-merges/${encodeURIComponent(id)}/download/${kind}`);
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  const writer = await handle.createWritable();
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.write(value);
      received += value.byteLength;
      onProgress(received);
    }
    await writer.close();
  } catch (error) {
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
