import type { ClippingLabelsView } from '../../clipping-handles';

export function mountClippingLabels(viewport: HTMLElement): ClippingLabelsView & { destroy(): void } {
  const labels = new Map<string, HTMLSpanElement>();
  for (const kind of ['axis', 'box']) for (const axis of ['x', 'y', 'z']) for (const side of ['min', 'max']) {
    const label = document.createElement('span');
    label.className = `clip-handle-label axis-${axis}`;
    label.textContent = `${side === 'min' ? '−' : '+'}${axis.toUpperCase()}`;
    label.hidden = true;
    viewport.appendChild(label);
    labels.set(`${kind}-${axis}-${side}`, label);
  }
  return {
    set(kind, axis, side, position) {
      const label = labels.get(`${kind}-${axis}-${side}`)!;
      label.hidden = !position?.visible;
      if (position) {
        label.style.left = `${position.x}px`;
        label.style.top = `${position.y}px`;
      }
    },
    destroy() { labels.forEach(label => label.remove()); },
  };
}
