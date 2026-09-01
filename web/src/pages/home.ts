async function openWorkspace(root: HTMLElement, sessionId: string): Promise<void> {
  history.pushState({}, '', `/?session=${sessionId}&api=v2`);
  const { renderGenericRegistration } = await import('./generic-registration');
  await renderGenericRegistration(root, sessionId);
}

export function renderHome(root: HTMLElement): void {
  root.innerHTML = `
    <main class="home">
      <h1>通用点云双向配准</h1>
      <p class="hint">模型 A、B 均支持 PLY、PCD、LAS、LAZ；业务矩阵方向与 ICP 移动模型可以独立选择。</p>
      <section class="card">
        <form id="upload-form">
          <label>模型 A<input name="model_a" type="file" accept=".ply,.pcd,.las,.laz" required></label>
          <label>模型 B<input name="model_b" type="file" accept=".ply,.pcd,.las,.laz" required></label>
          <label>最终业务矩阵方向<select name="output_direction"><option value="a_to_b">模型 A → 模型 B</option><option value="b_to_a">模型 B → 模型 A</option></select></label>
          <label>ICP 移动模型<select name="moving_model"><option value="auto">自动推荐</option><option value="a">移动模型 A</option><option value="b">移动模型 B</option></select></label>
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
        request.open('POST', '/api/v2/registration-sessions');
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
