import * as pc from 'playcanvas';

/** Give a drag to one handle, even where several gizmos overlap. */
export class TransformGizmoInput {
  private readonly hits = new Set<pc.TransformGizmo>();
  private active?: pc.TransformGizmo;
  private readonly listeners: pc.EventHandle[] = [];

  constructor(translate: pc.TransformGizmo, rotate: pc.TransformGizmo,
              onDragging: (active: boolean) => void, scale?: pc.TransformGizmo) {
    const tools = scale ? [translate, scale, rotate] : [translate, rotate];
    const refresh = () => {
      const owner = this.active ?? tools.find(tool => this.hits.has(tool)) ?? translate;
      for (const tool of tools) tool.mouseButtons[0] = tool === owner;
    };
    for (const tool of tools) {
      tool.mouseButtons[1] = tool.mouseButtons[2] = false;
      this.listeners.push(
        tool.on(pc.Gizmo.EVENT_POINTERMOVE, (_x, _y, hit) => {
          if (hit) this.hits.add(tool);
          else this.hits.delete(tool);
          refresh();
        }),
        tool.on(pc.TransformGizmo.EVENT_TRANSFORMSTART, () => {
          this.active = tool; refresh(); onDragging(true);
        }),
        tool.on(pc.TransformGizmo.EVENT_TRANSFORMEND, () => {
          this.active = undefined; refresh(); onDragging(false);
        }),
      );
    }
    refresh();
  }

  get hovered(): boolean { return this.hits.size > 0; }

  destroy(): void {
    this.listeners.splice(0).forEach(listener => listener.off());
  }
}
