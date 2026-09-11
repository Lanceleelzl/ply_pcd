import * as pc from 'playcanvas';

/** Shared input arbitration for an overlaid translation/rotation pair. */
export class TransformGizmoInput {
  private translateHovered = false;
  private rotateHovered = false;
  private translateDragging = false;
  private rotateDragging = false;
  private readonly listeners: pc.EventHandle[] = [];

  constructor(
    private readonly translate: pc.TransformGizmo,
    private readonly rotate: pc.TransformGizmo,
    private readonly onDragging: (active: boolean) => void,
  ) {
    for (const gizmo of [translate, rotate]) {
      gizmo.mouseButtons[1] = gizmo.mouseButtons[2] = false;
    }
    this.listeners.push(
      translate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, hit) => {
        this.translateHovered = Boolean(hit); this.refresh();
      }),
      rotate.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, hit) => {
        this.rotateHovered = Boolean(hit); this.refresh();
      }),
      translate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => this.setDragging('translate', true)),
      translate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => this.setDragging('translate', false)),
      rotate.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => this.setDragging('rotate', true)),
      rotate.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => this.setDragging('rotate', false)),
    );
    this.refresh();
  }

  get hovered(): boolean { return this.translateHovered || this.rotateHovered; }

  private setDragging(kind: 'translate' | 'rotate', active: boolean): void {
    if (kind === 'translate') this.translateDragging = active;
    else this.rotateDragging = active;
    this.refresh();
    this.onDragging(this.translateDragging || this.rotateDragging);
  }

  private refresh(): void {
    this.translate.mouseButtons[0] = this.translateDragging || !this.rotateDragging;
    this.rotate.mouseButtons[0] = this.rotateDragging
      || (!this.translateDragging && !this.translateHovered && this.rotateHovered);
  }

  destroy(): void {
    this.listeners.splice(0).forEach(listener => listener.off());
  }
}
