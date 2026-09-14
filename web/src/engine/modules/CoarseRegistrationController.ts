import type { CoarseRegistrationResult, ModelId } from '../../api/contracts.ts';
import { cancelCoarseRegistration, createCoarseRegistration, loadCoarseRegistrationResult } from '../../api/registration-api.ts';
import { apiFetch } from '../../api/api-auth.ts';

interface CoarseEvents {
  runningChanged(running: boolean): void;
  statusChanged(status: string): void;
  succeeded(result: CoarseRegistrationResult): void;
}

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const aborted = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
  signal.addEventListener('abort', aborted, { once: true });
});

export class CoarseRegistrationController {
  private readonly lifecycle = new AbortController();
  private jobId = '';
  private active = false;

  constructor(private readonly events: CoarseEvents, parentSignal?: AbortSignal) {
    if (parentSignal?.aborted) this.lifecycle.abort();
    else parentSignal?.addEventListener('abort', () => this.lifecycle.abort(), { once: true });
  }

  async run(sessionId: string, movingModel: ModelId): Promise<void> {
    if (this.active) return;
    const { signal } = this.lifecycle;
    signal.throwIfAborted();
    this.active = true;
    this.events.runningChanged(true);
    this.events.statusChanged('正在搜索自动粗配准候选……');
    try {
      const created = await createCoarseRegistration(sessionId, movingModel, signal);
      this.jobId = created.job_id;
      while (true) {
        const response = await apiFetch(created.status_url, { signal });
        const status = await response.json() as { status?: string; error?: string };
        if (!response.ok) throw new Error(status.error ?? `HTTP ${response.status}`);
        if (status.status === 'failed') throw new Error(status.error ?? '自动粗配准失败');
        if (status.status === 'cancelled') { this.events.statusChanged('已取消自动粗配准，原姿态未改变'); return; }
        if (status.status === 'succeeded') {
          const result = await loadCoarseRegistrationResult(created.result_url, signal);
          this.events.succeeded(result);
          return;
        }
        if (!['queued', 'running'].includes(status.status ?? '')) throw new Error('自动粗配准返回无效状态');
        await wait(500, signal);
      }
    } finally {
      this.jobId = '';
      this.active = false;
      if (!signal.aborted) this.events.runningChanged(false);
    }
  }

  async cancel(): Promise<void> {
    if (this.jobId) await cancelCoarseRegistration(this.jobId, this.lifecycle.signal);
  }

  destroy(): void {
    this.lifecycle.abort();
  }
}
