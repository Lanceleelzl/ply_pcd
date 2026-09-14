import type { ViewportInputDelegate } from '../engine/core/ViewportCameraController';

interface ClippingInput {
  readonly dragging: boolean;
  pointerMove(event: PointerEvent): boolean;
  pointerLeave(): void;
  pointerDown(event: PointerEvent): boolean;
  pointerUp(event: PointerEvent): void;
}

interface CoordinateQueryInput {
  readonly active: boolean;
  readonly hovered: boolean;
  readonly dragging: boolean;
  pointerDown(event: PointerEvent): boolean;
}

export interface WorkbenchInputOptions {
  canvas: HTMLCanvasElement;
  clipping: () => ClippingInput | null;
  query: () => CoordinateQueryInput | null;
  clippingInteractionActive: () => boolean;
  movingGizmoHovered: () => boolean;
  clippingGizmoHovered: () => boolean;
  gizmoTransforming: () => boolean;
  syncClipping: () => void;
}

export function createWorkbenchInputDelegate(options: WorkbenchInputOptions): ViewportInputDelegate {
  return {
    pointerMove: event => {
      const clipping = options.clipping();
      if (clipping?.pointerMove(event)) {
        options.canvas.style.cursor = clipping.dragging ? 'grabbing' : 'grab';
        return true;
      }
      options.canvas.style.cursor = '';
      return false;
    },
    pointerLeave: () => options.clipping()?.pointerLeave(),
    pointerDown: event => {
      if (options.query()?.pointerDown(event)) return true;
      return options.clipping()?.pointerDown(event) ?? false;
    },
    pointerUp: event => {
      options.clipping()?.pointerUp(event);
      options.syncClipping();
    },
    navigationBlocked: event => {
      const query = options.query();
      if (query?.active && (query.hovered || query.dragging) && event.button === 0) return true;
      const gizmoHovered = options.clippingInteractionActive()
        ? options.clippingGizmoHovered() : options.movingGizmoHovered();
      return event.button === 2 || options.gizmoTransforming() || (event.button === 0 && gizmoHovered);
    },
    dragBlocked: () => options.gizmoTransforming() || Boolean(options.query()?.dragging),
  };
}
