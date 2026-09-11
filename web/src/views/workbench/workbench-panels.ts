import type { VNode } from 'vue';

export type WorkbenchPanel = 'business' | 'roles' | 'pose' | 'icp' | 'actions' | 'clipping' | 'originPlanes' | 'query';
export type WorkbenchPanels = Partial<Record<WorkbenchPanel, () => VNode>>;
