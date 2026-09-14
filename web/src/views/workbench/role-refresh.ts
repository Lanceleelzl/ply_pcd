import type { ModelId } from '../../api/contracts';
import { applyModelRoleColors } from './model-role-presentation';
import { roleSummary } from './registration-role-state';
import type * as pc from 'playcanvas';

export function refreshWorkbenchRoles(entities: Record<ModelId, pc.Entity>, moving: ModelId, reset: () => void, updateSummary: (summary: string) => void, refreshTools: () => void): void {
  reset();
  applyModelRoleColors(entities, moving);
  updateSummary(roleSummary(moving));
  refreshTools();
}
