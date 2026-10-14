import { apiFetch, authenticateRequest } from './api-auth';
import type { XYZ } from '../coordinate-math';

export type EditorInputKind = 'single' | 'dataset' | 'lod_group';
export type EditorRule =
  | { type: 'polygon'; action: 'keep' | 'remove'; points: [number, number][] }
  | { type: 'sphere'; action: 'keep' | 'remove'; center: XYZ; radius: number }
  | { type: 'box'; action: 'keep' | 'remove'; center: XYZ; size: XYZ; rotation: [number, number, number, number] };
export interface EditorGeography { reference: XYZ; projected_origin: XYZ; axes: [number, number, number];
  metres_per_unit: number; source_epsg: number }
export interface EditorTransform { translation: XYZ; rotation_degrees: XYZ; scale: XYZ }
export interface EditorDisplayClip { mode: 'off' | 'axis' | 'box'; min: XYZ; max: XYZ; center: XYZ; size: XYZ;
  planes: Record<'xoy' | 'xoz' | 'yoz', { visible: boolean; side: number }> }
export interface EditorState { rules: EditorRule[]; selected_lods: number[]; geography?: EditorGeography | null;
  transform?: EditorTransform; display_clip?: EditorDisplayClip | null }
export interface EditorLod { level: number; name: string; bytes: number; format: string; gaussian_url: string }
export interface EditorResult { level: number; count: number; source_count: number; path: string; bytes: number }
export interface EditorTask {
  task_id: string; filename: string; input_kind: EditorInputKind; format: string;
  source_bytes?: number;
  status: 'queued' | 'preparing' | 'ready' | 'failed'; error?: string;
  metadata?: { source_point_count: number; preview_point_count: number; origin: XYZ; bounds: { min: XYZ; max: XYZ } };
  coordinate_metadata?: { epsg: string; offset: Array<string | null>; source: string };
  preview_url?: string | null; gaussian_url?: string | null; gaussian_filename?: string;
  lods: EditorLod[]; derived_lods: Array<{ version: string; count: number; source_level: number; gaussian_url: string }>;
  available_levels: number[];
  history: Array<{ label: string; state: EditorState; at: number }>;
  history_cursor: number;
  process_status: string; process_phase?: string; process_progress?: number | null;
  process_level?: number | null; process_completed?: number; process_total?: number;
  process_error?: string; process_results?: EditorResult[]; process_version?: string;
  decimate_status: string; decimate_phase?: string; decimate_progress?: number | null;
  decimate_error?: string;
  export_status?: string; export_phase?: string; export_progress?: number | null;
  export_error?: string; export_request?: { version: string; level: number; format: 'compressed_ply' | 'sog' };
  exports?: Array<{ version: string; level: number; format: 'compressed_ply' | 'sog'; path: string; bytes: number }>;
  versions: Array<{ version: string; created_at_unix: number; history_cursor: number; levels: EditorResult[] }>;
  created_at_unix: number; updated_at_unix?: number;
}

const base = '/api/v2/gaussian-editor-tasks';

async function jsonResponse<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(value.detail ?? `HTTP ${response.status}`);
  return value;
}

export function createEditorTask(input: { kind: EditorInputKind; workspaceId: string;
  file?: File; files?: File[]; paths?: string[]; onProgress?: (loaded: number, total: number) => void }): Promise<EditorTask> {
  const form = new FormData();
  form.set('input_kind', input.kind);
  form.set('workspace_id', input.workspaceId);
  if (input.file) form.set('file', input.file);
  input.files?.forEach((file, index) => form.append('files', file, input.paths?.[index] ?? file.name));
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', base);
    authenticateRequest(request);
    request.upload.onprogress = event => input.onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
    request.onerror = () => reject(new Error('上传连接中断'));
    request.onload = () => {
      let value: EditorTask & { detail?: string };
      try { value = JSON.parse(request.responseText) as EditorTask & { detail?: string }; }
      catch { reject(new Error(`创建任务失败：HTTP ${request.status}`)); return; }
      if (request.status >= 200 && request.status < 300) resolve(value);
      else reject(new Error(value.detail ?? `HTTP ${request.status}`));
    };
    request.send(form);
  });
}

export async function listEditorTasks(workspaceId: string): Promise<EditorTask[]> {
  return jsonResponse(await apiFetch(`${base}?workspace_id=${encodeURIComponent(workspaceId)}`));
}
export async function loadEditorTask(taskId: string): Promise<EditorTask> {
  return jsonResponse(await apiFetch(`${base}/${encodeURIComponent(taskId)}`));
}
export async function recordEditorEdit(taskId: string, label: string, state: EditorState): Promise<EditorTask> {
  return jsonResponse(await apiFetch(`${base}/${encodeURIComponent(taskId)}/edits`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, state }),
  }));
}
export async function jumpEditorHistory(taskId: string, index: number): Promise<EditorTask> {
  return jsonResponse(await apiFetch(`${base}/${encodeURIComponent(taskId)}/history/${index}`, { method: 'POST' }));
}
export async function processEditorTask(taskId: string, levels: number[]): Promise<EditorTask> {
  return jsonResponse(await apiFetch(`${base}/${encodeURIComponent(taskId)}/process`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ levels }),
  }));
}
export async function decimateEditorTask(taskId: string, level: number, targetCount: number): Promise<EditorTask> {
  return jsonResponse(await apiFetch(`${base}/${encodeURIComponent(taskId)}/decimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level, target_count: targetCount }),
  }));
}
export function editorDownloadUrl(taskId: string, version: string, level: number): string {
  return `${base}/${encodeURIComponent(taskId)}/download/${encodeURIComponent(version)}/${level}`;
}
export async function exportEditorResult(taskId: string, version: string, level: number,
  format: 'compressed_ply' | 'sog'): Promise<EditorTask> {
  return jsonResponse(await apiFetch(`${base}/${encodeURIComponent(taskId)}/exports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, level, format }),
  }));
}
export function editorExportUrl(taskId: string, version: string, level: number,
  format: 'compressed_ply' | 'sog'): string {
  return `${base}/${encodeURIComponent(taskId)}/exports/${encodeURIComponent(version)}/${level}/${format}`;
}
export function editorManifestUrl(taskId: string, version: string, level: number,
  format: 'ply' | 'compressed_ply' | 'sog'): string {
  return `${base}/${encodeURIComponent(taskId)}/manifest/${encodeURIComponent(version)}/${level}/${format}`;
}
export async function queryEditorCoordinates(taskId: string, point: XYZ, frame: EditorGeography): Promise<{
  independent: XYZ; projected: XYZ; longitude: number; latitude: number; height_note: string }> {
  return jsonResponse(await apiFetch(`${base}/${encodeURIComponent(taskId)}/coordinate-query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      point, axes: frame.axes, reference: frame.reference, independent_origin: [0, 0, 0],
      projected_origin: frame.projected_origin, metres_per_unit: frame.metres_per_unit,
      source_epsg: frame.source_epsg, target_epsg: 4326,
    }),
  }));
}
