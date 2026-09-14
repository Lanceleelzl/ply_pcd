import type { RegistrationIteration, RegistrationRequest, RegistrationResult } from '../../api/contracts';
import { apiFetch, authenticatedHeaders, getApiKey } from '../../api/api-auth.ts';

interface RegistrationJobEvents {
  runningChanged(running: boolean): void;
  statusChanged(status: string): void;
  progressChanged(progress: RegistrationIteration): void;
  succeeded(result: RegistrationResult, jobId: string): void;
  cancelled(lastProgress: RegistrationIteration | null): void;
}

interface CreatedJob {
  job_id: string;
  status_url: string;
  progress_url: string;
  detail?: string;
}

interface JobStatus {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result_url?: string;
  error?: string;
  detail?: string;
}

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted();
  const aborted = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', aborted);
    resolve();
  }, milliseconds);
  signal.addEventListener('abort', aborted, { once: true });
});

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { detail?: string };
  if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
  return body;
}

export class RegistrationJobController {
  private readonly lifecycle = new AbortController();
  private readonly abortFromParent = () => { this.lifecycle.abort(); this.closeProgress(); };
  private progressSource: EventSource | null = null;
  private activeJobId = '';
  private activeProgressUrl = '';
  private cancelRequested = false;
  private progressVisible = false;
  private latestProgress: RegistrationIteration | null = null;
  private active = false;

  constructor(
    private readonly events: RegistrationJobEvents,
    private readonly parentSignal?: AbortSignal,
  ) {
    if (parentSignal?.aborted) this.lifecycle.abort();
    else parentSignal?.addEventListener('abort', this.abortFromParent, { once: true });
  }

  get running(): boolean {
    return this.active;
  }

  setProgressVisible(visible: boolean): void {
    this.progressVisible = visible;
    if (visible && this.active) this.openProgress();
    else if (!visible) this.closeProgress();
  }

  async run(sessionId: string, request: RegistrationRequest): Promise<void> {
    if (this.active) return;
    const { signal } = this.lifecycle;
    signal.throwIfAborted();
    this.active = true;
    this.activeJobId = '';
    this.activeProgressUrl = '';
    this.cancelRequested = false;
    this.latestProgress = null;
    this.events.runningChanged(true);
    this.events.statusChanged('正在提交……');
    try {
      const created = await apiFetch(`/api/v2/registration-sessions/${encodeURIComponent(sessionId)}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      }).then(response => jsonResponse<CreatedJob>(response));
      signal.throwIfAborted();
      this.activeJobId = created.job_id;
      this.activeProgressUrl = created.progress_url;
      if (this.progressVisible) this.openProgress();
      if (this.cancelRequested) await this.sendCancel();

      while (!signal.aborted) {
        const status = await apiFetch(created.status_url, { signal }).then(response => jsonResponse<JobStatus>(response));
        signal.throwIfAborted();
        if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status.status)) throw new Error('任务响应包含无效状态');
        this.events.statusChanged(`任务状态：${status.status}`);
        if (status.status === 'cancelled') {
          this.events.cancelled(this.latestProgress);
          return;
        }
        if (status.status === 'failed') throw new Error(status.error ?? 'ICP 失败');
        if (status.status === 'succeeded') {
          if (!status.result_url) throw new Error('任务成功但缺少结果地址');
          const result = await apiFetch(status.result_url, { signal }).then(response => jsonResponse<RegistrationResult>(response));
          signal.throwIfAborted();
          this.closeProgress();
          this.events.succeeded(result, this.activeJobId);
          return;
        }
        await wait(1000, signal);
      }
    } finally {
      this.closeProgress();
      this.activeJobId = '';
      this.activeProgressUrl = '';
      this.cancelRequested = false;
      this.active = false;
      if (!signal.aborted) this.events.runningChanged(false);
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.cancelRequested = true;
    if (this.activeJobId) await this.sendCancel();
  }

  destroy(): void {
    this.parentSignal?.removeEventListener('abort', this.abortFromParent);
    this.lifecycle.abort();
    this.closeProgress();
  }

  private async sendCancel(): Promise<void> {
    const response = await apiFetch(`/api/v2/registrations/${this.activeJobId}/cancel`, {
      method: 'POST',
      signal: this.lifecycle.signal,
    });
    if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
  }

  private openProgress(): void {
    if (this.lifecycle.signal.aborted || !this.activeProgressUrl || this.progressSource) return;
    if (getApiKey()) {
      const controller = new AbortController();
      this.progressSource = { close: () => controller.abort() } as EventSource;
      void this.readAuthenticatedProgress(controller);
      return;
    }
    const source = new EventSource(`${this.activeProgressUrl}?from_latest=true`);
    this.progressSource = source;
    source.addEventListener('iteration', event => {
      if (this.lifecycle.signal.aborted || this.progressSource !== source) return;
      const progress = JSON.parse((event as MessageEvent<string>).data) as RegistrationIteration;
      if (progress.iteration <= (this.latestProgress?.iteration ?? 0)) return;
      this.latestProgress = progress;
      this.events.progressChanged(progress);
    });
    source.addEventListener('terminal', () => {
      if (this.progressSource === source) this.closeProgress();
    });
  }

  private async readAuthenticatedProgress(controller: AbortController): Promise<void> {
    try {
      const response = await fetch(`${this.activeProgressUrl}?from_latest=true`, {
        headers: authenticatedHeaders(), signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          const data = block.match(/^data: (.+)$/m)?.[1];
          if (event === 'iteration' && data) {
            const progress = JSON.parse(data) as RegistrationIteration;
            if (progress.iteration > (this.latestProgress?.iteration ?? 0)) {
              this.latestProgress = progress; this.events.progressChanged(progress);
            }
          } else if (event === 'terminal') { this.closeProgress(); return; }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) this.events.statusChanged(`进度连接失败：${String(error)}`);
    }
  }

  private closeProgress(): void {
    this.progressSource?.close();
    this.progressSource = null;
  }
}
