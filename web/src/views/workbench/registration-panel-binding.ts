import { h } from 'vue';
import type { ModelId, RegistrationRequest } from '../../api/contracts';
import type { TransformParameters } from '../../coordinate-math';
import type { createBusinessTransformState } from '../../stores/business-transform-state';
import type { createWorkbenchActivity } from '../../stores/workbench-activity';
import type { IcpParameterValues } from './icp-parameter-state';
import type { createRegistrationRoleState } from './registration-role-state';
import BusinessTransformPanel from './BusinessTransformPanel.vue';
import CoarsePoseForm from './CoarsePoseForm.vue';
import IcpParameters from './IcpParameters.vue';
import RegistrationActions from './RegistrationActions.vue';
import RegistrationRoles from './RegistrationRoles.vue';

type ActivityState = ReturnType<typeof createWorkbenchActivity>['state'];
type BusinessState = ReturnType<typeof createBusinessTransformState>;
type RoleState = ReturnType<typeof createRegistrationRoleState>;

export interface RegistrationPanelBindingOptions {
  activity: ActivityState;
  role: RoleState;
  recommendedMoving: ModelId;
  modelDiagonals: Record<ModelId, number>;
  pose: { values: number[] };
  business: BusinessState;
  icp: IcpParameterValues;
  actions: {
    run(): Promise<void>;
    cancel(): Promise<void>;
    setProgress(visible: boolean): void;
  };
  changePose(values: number[]): void;
  changeMoving(value: RegistrationRequest['moving_model']): void;
  changeDirection(value: RegistrationRequest['output_direction']): void;
  changeBusiness(model: ModelId, kind: keyof TransformParameters, index: number, value: string): void;
  changeIcp(key: string, value: string): void;
}

export function createRegistrationPanelBindings(options: RegistrationPanelBindingOptions) {
  const { activity, role, pose, business, icp, actions } = options;
  return {
    pose: () => h(CoarsePoseForm, { ...pose, disabled: activity.editingLocked, onChange: options.changePose }),
    roles: () => h(RegistrationRoles, {
      ...role, disabled: activity.editingLocked,
      recommended: options.recommendedMoving, diagonals: options.modelDiagonals,
      onMoving: options.changeMoving, onDirection: options.changeDirection,
    }),
    business: () => h(BusinessTransformPanel, {
      drafts: business.drafts, ...business.state,
      onChange: options.changeBusiness, onReset: business.reset, onApply: business.apply,
    }),
    icp: () => h(IcpParameters, { values: icp, disabled: activity.editingLocked, onChange: options.changeIcp }),
    actions: () => h(RegistrationActions, {
      running: activity.running, locked: activity.queryActive,
      cancelling: activity.cancelling, progress: activity.progress,
      onRun: actions.run, onCancel: actions.cancel, onProgress: actions.setProgress,
    }),
  };
}
