import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { loadRegistrationSession } from '../api/registration-api';
import type { ModelId } from '../api/contracts';

// V2 excludes sessions submitted without a cache request. Do not migrate the old
// key because it tracked every upload and surfaces unrelated historical failures.
const STORAGE_KEY = 'ply-pcd-stream-cache-sessions-v2';
type CacheStatus = 'queued' | 'converting' | 'ready' | 'failed';
interface TrackedSession { sessionId: string; workspaceId: string; labels?: Partial<Record<ModelId, string>> }
export interface CacheTask {
  key: string; sessionId: string; model: ModelId; label: string; format: string;
  status: CacheStatus; progress: number | null; error?: string;
}

function readTracked(): TrackedSession[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as TrackedSession[];
    return Array.isArray(value) ? value.filter(item => item?.sessionId && item?.workspaceId) : [];
  } catch { return []; }
}

export const useBackgroundCacheStore = defineStore('background-cache', () => {
  const tracked = ref<TrackedSession[]>(readTracked());
  const tasks = ref<CacheTask[]>([]);
  const refreshing = ref(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  const activeCount = computed(() => tasks.value.filter(task => task.status === 'queued' || task.status === 'converting').length);
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(tracked.value));
  function track(sessionId: string, workspaceId: string, labels?: Partial<Record<ModelId, string>>): void {
    const existing = tracked.value.find(item => item.sessionId === sessionId);
    if (existing) existing.labels = { ...existing.labels, ...labels };
    else tracked.value.unshift({ sessionId, workspaceId, labels });
    tracked.value = tracked.value.slice(0, 30);
    persist();
    void refresh();
  }
  async function refresh(): Promise<void> {
    if (refreshing.value || !tracked.value.length) return;
    refreshing.value = true;
    const next: CacheTask[] = [];
    await Promise.all(tracked.value.map(async item => {
      try {
        const session = await loadRegistrationSession(item.sessionId);
        for (const model of ['a', 'b'] as ModelId[]) {
          const dataset = session.inputs?.[`model_${model}_dataset`];
          const status = dataset?.gaussian_cache_status;
          if (!status || status === 'not_requested') continue;
          next.push({ key: `${item.sessionId}:${model}`, sessionId: item.sessionId, model,
            label: item.labels?.[model] ?? `模型 ${model.toUpperCase()}`,
            format: dataset.format?.toUpperCase() ?? 'GAUSSIAN', status,
            progress: typeof dataset.gaussian_cache_progress === 'number' ? dataset.gaussian_cache_progress : null,
            error: dataset.gaussian_cache_error });
        }
      } catch { /* 会话可能已清理，保留其他任务。 */ }
    }));
    const order: Record<CacheStatus, number> = { converting: 0, queued: 1, failed: 2, ready: 3 };
    tasks.value = next.sort((left, right) => order[left.status] - order[right.status]).slice(0, 20);
    refreshing.value = false;
  }
  function start(): void {
    if (timer) return;
    void refresh();
    timer = setInterval(refresh, 2000);
  }
  return { tasks, activeCount, refreshing, track, refresh, start };
});
