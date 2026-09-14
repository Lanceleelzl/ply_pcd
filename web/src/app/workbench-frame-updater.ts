import type * as pc from 'playcanvas';

export interface WorkbenchFrameUpdater {
  invalidateResult: () => void;
  readPose: () => pc.Vec3[];
  updatePose: (values: number[]) => void;
  readMatrix: () => string;
  updateMatrix: (value: string) => void;
  syncClipping: () => void;
  updateClippingHandles: () => void;
}

export function createWorkbenchFrameUpdater(actions: WorkbenchFrameUpdater): () => void {
  return () => {
    actions.invalidateResult();
    const pose = actions.readPose();
    actions.updatePose(pose.flatMap(value => [value.x, value.y, value.z]));
    actions.updateMatrix(actions.readMatrix());
    actions.syncClipping();
    actions.updateClippingHandles();
  };
}

export function bindWorkbenchFrameUpdates(app: pc.Application, updater: () => void): () => void {
  app.on('update', updater);
  return () => app.off('update', updater);
}
