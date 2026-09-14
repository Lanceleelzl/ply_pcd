import type { InspectorState } from './inspector-state';
import { createCoordinatePanel } from './coordinate-fields';
import { mountCoordinateLabels } from './coordinate-labels';

export function createCoordinateQueryViews(root: HTMLElement, inspector: InspectorState, handlers: Parameters<typeof createCoordinatePanel>[2]) {
  const panel = createCoordinatePanel(root, inspector, handlers);
  const labels = mountCoordinateLabels(root);
  return { panel, labels, destroy: () => labels.destroy() };
}
