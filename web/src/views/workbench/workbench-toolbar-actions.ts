import type { ModelId } from '../../api/contracts';
import type { ToolbarCommand } from './toolbar-state';

export interface WorkbenchToolbarActions {
  reset: () => void;
  fit: () => void;
  toggleClipping: () => void;
  toggleOriginPlanes: () => void;
  toggleQuery: () => void;
  setModelVisible: (model: ModelId) => void;
  toggleOrigin: (model: ModelId) => boolean;
  toggleGaussian: (model: ModelId) => void;
}

export function createWorkbenchToolbarHandler(actions: WorkbenchToolbarActions) {
  return (command: ToolbarCommand): void => {
    switch (command.type) {
      case 'reset': actions.reset(); break;
      case 'fit': actions.fit(); break;
      case 'clipping': actions.toggleClipping(); break;
      case 'origin-planes': actions.toggleOriginPlanes(); break;
      case 'query': actions.toggleQuery(); break;
      case 'visibility': actions.setModelVisible(command.model); break;
      case 'origin-axes': actions.toggleOrigin(command.model); break;
      case 'gaussian': actions.toggleGaussian(command.model); break;
    }
  };
}
