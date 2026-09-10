import type { ModelId } from '../../api/contracts';

export function mountViewportToolbar(root: HTMLElement, actions: {
  query: () => void;
  toggleOrigin: (model: ModelId) => boolean;
}) {
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
