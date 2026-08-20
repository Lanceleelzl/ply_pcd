async function openWorkspace(root: HTMLElement, sessionId: string): Promise<void> {
  history.pushState({}, '', `/?session=${sessionId}`);
  const { renderManualRegistration } = await import('./manual-registration');
  await renderManualRegistration(root, sessionId);
}

export function renderHome(root: HTMLElement): void {
  root.innerHTML = `
    <main class="home">
      <h1>PLY／PCD 坐标配准</h1>
      <p class="hint">PCD 作为移动点云配准到固定的 Gaussian PLY，最终输出 PLY→PCD 业务矩阵。</p>
      <section class="card">
        <form id="upload-form">
          <label>Gaussian PLY<input name="ply" type="file" accept=".ply" required></label>
          <label>SLAM PCD<input name="pcd" type="file" accept=".pcd" required></label>
          <div class="actions"><button class="primary" type="submit">上传并进入配准工作台</button></div>
        </form>
        <pre id="status" class="status">请选择文件。</pre>
      </section>
    </main>`;
  const form = root.querySelector<HTMLFormElement>('#upload-form')!;
  const status = root.querySelector<HTMLElement>('#status')!;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.disabled = true;
    status.textContent = '正在上传：0%';
    try {
      const result = await new Promise<{ session_id: string }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/v1/manual-registration-sessions');
        request.upload.addEventListener('progress', progress => {
          if (progress.lengthComputable) status.textContent = `正在上传：${Math.round(progress.loaded / progress.total * 100)}%`;
        });
        request.addEventListener('load', () => {
          const body = JSON.parse(request.responseText || '{}');
          if (request.status >= 200 && request.status < 300) resolve(body);
          else reject(new Error(body.detail ?? `HTTP ${request.status}`));
        });
        request.addEventListener('error', () => reject(new Error('网络连接失败')));
        request.send(new FormData(form));
      });
      status.textContent = '上传完成，正在生成点云预览……';
      await openWorkspace(root, result.session_id);
    } catch (error) {
      status.textContent = `创建失败：${String(error)}`;
      submit.disabled = false;
    }
  });
}
