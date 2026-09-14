import type * as pc from 'playcanvas';
import type { ModelId } from '../../api/contracts';

export function setWorkbenchModelVisible(
  model: ModelId,
  visible: boolean,
  states: Record<ModelId, boolean>,
  entities: Record<ModelId, pc.Entity>,
  refreshTools: () => void,
): void {
  states[model] = visible;
  entities[model].enabled = visible;
  refreshTools();
}

export function toggleWorkbenchModelVisible(
  model: ModelId,
  states: Record<ModelId, boolean>,
  entities: Record<ModelId, pc.Entity>,
  refreshTools: () => void,
): boolean {
  const next = !states[model];
  setWorkbenchModelVisible(model, next, states, entities, refreshTools);
  return next;
}
