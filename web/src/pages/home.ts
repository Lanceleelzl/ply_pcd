import { transformParametersMatrix, type TransformParameters } from '../coordinate-math';

interface HistoryItem {
  session_id: string;
  completed_at_unix?: number;
  source_expires_at_unix?: number;
  source_available: boolean;
  restartable: boolean;
  output_direction?: 'a_to_b' | 'b_to_a';
  models?: Record<'a' | 'b', { filename?: string; format?: string; bytes?: number }>;
  recommended_matrix?: { name?: string; value?: number[][] };
  metrics?: { final_rms?: number; final_point_count?: number; elapsed_seconds?: number };
}

const WORKSPACE_KEY = 'ply-pcd-registration-workspace-id';

function getWorkspaceId(): string {
  let id = localStorage.getItem(WORKSPACE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(WORKSPACE_KEY, id);
  }
  return id;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value)) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value!;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function matrixText(matrix?: number[][]): string {
  return matrix?.map(row => row.map(value => Number(value).toFixed(12)).join(' ')).join('\n') ?? '';
}

const defaultTransform = (): TransformParameters => ({ translation: [0, 0, 0], rotation_degrees: [0, 0, 0], scale: [1, 1, 1] });
function transformEditor(model: 'a' | 'b'): string {
  const row = (kind: keyof TransformParameters, defaults: number[]) => `<div class="transform-row"><span>${kind === 'translation' ? '平移／m' : kind === 'rotation_degrees' ? '旋转／°' : '缩放'}</span>${['X', 'Y', 'Z'].map((axis, i) => `<label>${axis}<input type="number" step="any" data-transform-model="${model}" data-transform-kind="${kind}" data-index="${i}" value="${defaults[i]}"></label>`).join('')}</div>`;
  return `<details class="upload-transform"><summary>模型 ${model.toUpperCase()} 业务坐标预变换（默认不转换）</summary>${row('translation', [0,0,0])}${row('rotation_degrees', [0,0,0])}${row('scale', [1,1,1])}<div class="upload-transform-matrix"><span>文件坐标 → 业务坐标矩阵</span><pre data-transform-matrix="${model}">${matrixText(transformParametersMatrix(defaultTransform()))}</pre></div></details>`;
}

async function openWorkspace(root: HTMLElement, sessionId: string): Promise<void> {
  history.pushState({}, '', `/?session=${sessionId}&api=v2`);
  const { renderGenericRegistration } = await import('./generic-registration');
  await renderGenericRegistration(root, sessionId);
}

async function postSessionAction(sessionId: string, action: string, workspaceId: string): Promise<Response> {
  return fetch(`/api/v2/registration-sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
}

function renderHistoryItems(container: HTMLElement, items: HistoryItem[]): void {
  if (!items.length) {
    container.innerHTML = '<p class="history-empty">完成一次 ICP 精配准后，最终矩阵会显示在这里。</p>';
    return;
  }
  container.innerHTML = items.map(item => {
    const a = item.models?.a ?? {};
    const b = item.models?.b ?? {};
    const matrix = matrixText(item.recommended_matrix?.value);
    const completed = item.completed_at_unix
      ? new Date(item.completed_at_unix * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
    const expires = item.source_available && item.source_expires_at_unix
      ? `源文件保留至 ${new Date(item.source_expires_at_unix * 1000).toLocaleString('zh-CN', { hour12: false })}`
      : '源文件已释放，仅保留结果';
    return `<article class="history-item" data-session-id="${escapeHtml(item.session_id)}">
      <div class="history-heading"><strong>${escapeHtml(item.recommended_matrix?.name ?? (item.output_direction === 'b_to_a' ? 'T_b_to_a' : 'T_a_to_b'))}</strong><time>${escapeHtml(completed)}</time></div>
      <div class="history-models">
        <span>A：${escapeHtml(a.filename ?? '模型 A')}（${escapeHtml((a.format ?? '').toUpperCase())}，${formatBytes(a.bytes)}）</span>
        <span>B：${escapeHtml(b.filename ?? '模型 B')}（${escapeHtml((b.format ?? '').toUpperCase())}，${formatBytes(b.bytes)}）</span>
      </div>
      <div class="history-metrics">RMS ${item.metrics?.final_rms?.toFixed(6) ?? '—'} m · ${item.metrics?.final_point_count?.toLocaleString() ?? '—'} 点 · ${item.metrics?.elapsed_seconds?.toFixed(2) ?? '—'} s</div>
      <div class="history-retention ${item.source_available ? '' : 'released'}">${escapeHtml(expires)}</div>
      <details><summary>查看最终矩阵</summary><pre class="history-matrix">${escapeHtml(matrix)}</pre></details>
      <div class="history-actions">
        <button type="button" data-action="copy" ${matrix ? '' : 'disabled'}>复制矩阵</button>
        <button type="button" data-action="resume" ${item.restartable ? '' : 'disabled'}>继续配准</button>
        <button type="button" data-action="retain" ${item.source_available ? '' : 'disabled'}>再保留 24 小时</button>
        <button type="button" class="danger" data-action="release" ${item.source_available ? '' : 'disabled'}>释放源文件</button>
      </div>
    </article>`;
  }).join('');
}

export function renderHome(root: HTMLElement): void {
  const workspaceId = getWorkspaceId();
  root.innerHTML = `
    <main class="home">
      <header class="home-header"><h1>通用点云双向配准</h1><p class="hint">模型 A、B 均支持 PLY、PCD、LAS、LAZ；业务矩阵方向与 ICP 移动模型可以独立选择。</p></header>
      <div class="home-layout">
        <section class="card upload-card">
          <h2>新建配准任务</h2>
          <form id="upload-form">
            <label>模型 A<input name="model_a" type="file" accept=".ply,.pcd,.las,.laz" required></label>
            ${transformEditor('a')}
            <label>模型 B<input name="model_b" type="file" accept=".ply,.pcd,.las,.laz" required></label>
            ${transformEditor('b')}
            <label>最终业务矩阵方向<select name="output_direction"><option value="a_to_b">模型 A → 模型 B</option><option value="b_to_a">模型 B → 模型 A</option></select></label>
            <label>ICP 移动模型<select name="moving_model"><option value="auto">自动推荐</option><option value="a">移动模型 A</option><option value="b">移动模型 B</option></select></label>
            <div class="actions"><button class="primary" type="submit">上传并进入配准工作台</button></div>
          </form>
          <pre id="status" class="status">请选择文件。源模型默认保留 24 小时，最终矩阵长期保留。</pre>
        </section>
        <aside class="history-panel">
          <div class="history-title"><div><h2>历史结果</h2><p>按完成时间倒序</p></div><button id="refresh-history" type="button">刷新</button></div>
          <div id="history-list" class="history-list"><p class="history-empty">正在读取历史结果……</p></div>
        </aside>
      </div>
    </main>`;

  const form = root.querySelector<HTMLFormElement>('#upload-form')!;
  const status = root.querySelector<HTMLElement>('#status')!;
  const historyList = root.querySelector<HTMLElement>('#history-list')!;
  const readTransform = (model: 'a' | 'b'): TransformParameters => {
    const values = (kind: keyof TransformParameters) => Array.from(form.querySelectorAll<HTMLInputElement>(`[data-transform-model="${model}"][data-transform-kind="${kind}"]`)).map(input => Number(input.value));
    return { translation: values('translation') as [number,number,number], rotation_degrees: values('rotation_degrees') as [number,number,number], scale: values('scale') as [number,number,number] };
  };
  form.addEventListener('input', event => {
    const model = (event.target as HTMLElement).dataset.transformModel as 'a' | 'b' | undefined;
    if (!model) return;
    try { form.querySelector(`[data-transform-matrix="${model}"]`)!.textContent = matrixText(transformParametersMatrix(readTransform(model))); } catch { /* submit validation reports invalid values */ }
  });
  const loadHistory = async (): Promise<void> => {
    try {
      const response = await fetch(`/api/v2/registration-history?workspace_id=${encodeURIComponent(workspaceId)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      renderHistoryItems(historyList, (await response.json() as { items: HistoryItem[] }).items);
    } catch (error) {
      historyList.innerHTML = `<p class="history-empty">历史结果读取失败：${escapeHtml(error)}</p>`;
    }
  };

  root.querySelector('#refresh-history')!.addEventListener('click', () => void loadHistory());
  historyList.addEventListener('click', async event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    const item = button?.closest<HTMLElement>('.history-item');
    if (!button || !item || button.disabled) return;
    const action = button.dataset.action!;
    if (action === 'copy') {
      await navigator.clipboard.writeText(item.querySelector('.history-matrix')?.textContent ?? '');
      const label = button.textContent; button.textContent = '已复制';
      setTimeout(() => { button.textContent = label; }, 1200);
      return;
    }
    if (action === 'release' && !confirm('将删除本任务的原始模型、预览缓存和运行日志，只保留最终矩阵与结果摘要。是否继续？')) return;
    button.disabled = true;
    try {
      const response = await postSessionAction(item.dataset.sessionId!, action, workspaceId);
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
      if (action === 'resume') await openWorkspace(root, item.dataset.sessionId!);
      else await loadHistory();
    } catch (error) {
      alert(`操作失败：${String(error)}`); button.disabled = false;
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.disabled = true; status.textContent = '正在上传：0%';
    try {
      const result = await new Promise<{ session_id: string }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/v2/registration-sessions');
        request.upload.addEventListener('progress', progress => {
          if (progress.lengthComputable) status.textContent = `正在上传：${Math.round(progress.loaded / progress.total * 100)}%`;
        });
        request.addEventListener('load', () => {
          let body: { session_id?: string; detail?: string } = {};
          try { body = JSON.parse(request.responseText || '{}'); } catch { /* non-JSON error */ }
          if (request.status >= 200 && request.status < 300 && body.session_id) resolve({ session_id: body.session_id });
          else reject(new Error(body.detail ?? `HTTP ${request.status}`));
        });
        request.addEventListener('error', () => reject(new Error('网络连接失败')));
        const transforms = { a: readTransform('a'), b: readTransform('b') };
        for (const transform of Object.values(transforms)) {
          if ([...transform.translation, ...transform.rotation_degrees, ...transform.scale].some(value => !Number.isFinite(value))) throw new Error('预变换参数必须是有效数字');
          if (transform.scale.some(value => value <= 0)) throw new Error('缩放必须大于 0');
        }
        const data = new FormData(form); data.append('workspace_id', workspaceId);
        data.append('model_a_transform', JSON.stringify(transforms.a)); data.append('model_b_transform', JSON.stringify(transforms.b)); request.send(data);
      });
      status.textContent = '上传完成，正在生成点云预览……';
      await openWorkspace(root, result.session_id);
    } catch (error) {
      status.textContent = `创建失败：${String(error)}`; submit.disabled = false;
    }
  });
  void loadHistory();
}
