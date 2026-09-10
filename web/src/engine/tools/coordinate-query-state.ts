import type { ModelId } from '../../api/contracts';
import type { XYZ } from '../../coordinate-math';

export interface CoordinatePanelState {
  source: ModelId;
  points: Record<ModelId, XYZ> | null;
  original: boolean;
  clippingActive: boolean;
  jobId: string;
  message: string;
}

export interface CoordinatePanelView {
  state: CoordinatePanelState;
  setVisible: (visible: boolean) => void;
}
