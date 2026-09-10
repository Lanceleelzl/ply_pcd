import type { ModelId } from '../../api/contracts';

export function mountViewportToolbar(root: HTMLElement, actions: {
  query: () => void;
  toggleOrigin: (model: ModelId) => boolean;
}) {
    const toolbar = root.querySelector('.viewport-toolbar')!;
    toolbar.insertAdjacentHTML('beforeend', '<button id="coordinate-query" disabled title="完成 ICP 后可查询坐标对">坐标查询</button><button id="origin-a" aria-pressed="false">A 原点／轴</button><button id="origin-b" aria-pressed="false">B 原点／轴</button>');
    toolbar.querySelector('strong')?.remove();
    const groups = [
      ['配准与视图', ['reset', 'fit', 'clipping-toggle']],
      ['模型显隐', ['toggle-model-a', 'toggle-model-b']],
      ['高斯显示', ['gaussian-model-a', 'gaussian-model-b']],
      ['平面工具', ['origin-planes-toggle']],
      ['坐标工具', ['coordinate-query', 'origin-a', 'origin-b']],
    ] as const;
    for (const [label, ids] of groups) {
      const group = document.createElement('div');
      group.className = 'viewport-tool-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      group.innerHTML = `<span class="tool-group-label">${label}</span>`;
      ids.forEach(id => group.append(root.querySelector(`#${id}`)!));
      toolbar.append(group);
    }
    toolbar.querySelector('.model-visibility')?.remove();
  const toggle = root.querySelector<HTMLButtonElement>('#coordinate-query')!;
  const lifecycle = new AbortController();
  toggle.addEventListener('click', actions.query, { signal: lifecycle.signal });
  for (const model of ['a', 'b'] as const) {
    const button = root.querySelector<HTMLButtonElement>(`#origin-${model}`)!;
    button.addEventListener('click', () => {
      const active = actions.toggleOrigin(model);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }, { signal: lifecycle.signal });
  }
  return {
    setAvailable(available: boolean, title: string) { toggle.disabled = !available; toggle.title = title; },
    setActive(active: boolean) { toggle.classList.toggle('active', active); },
    destroy() { lifecycle.abort(); },
  };
}
