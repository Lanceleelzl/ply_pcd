import type { CoordinateLabelsView } from '../../engine/tools/coordinate-query-state';

export function mountCoordinateLabels(root: HTMLElement): CoordinateLabelsView & { destroy: () => void } {
  const viewport = root.querySelector('.viewport')!;
  const create = (model: string) => ['点', '0', 'X', 'Y', 'Z'].map((suffix, index) => {
    const element = document.createElement('span');
    element.className = 'coordinate-label';
    element.textContent = index === 0 ? `${model} 点` : `${model}-${suffix}`;
    element.hidden = true;
    viewport.append(element);
    return element;
  });
  const labels = { a: create('A'), b: create('B') };
  return {
    set(model, index, position) {
      const element = labels[model][index];
      element.hidden = !position;
      if (position) { element.style.left = `${position.x}px`; element.style.top = `${position.y}px`; }
    },
    destroy() { Object.values(labels).flat().forEach(element => element.remove()); },
  };
}
