export interface EditingTool<TId extends string> {
  id: TId;
  activate(): void;
  deactivate(): void;
}

export class ToolManager<TId extends string> {
  private readonly tools = new Map<TId, EditingTool<TId>>();
  private activeTool: EditingTool<TId> | null = null;

  register(tool: EditingTool<TId>): void {
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
  }

  activate(id: TId): void {
    const next = this.tools.get(id);
    if (!next) throw new Error(`Unknown tool: ${id}`);
    if (next === this.activeTool) {
      next.activate();
      return;
    }
    this.activeTool?.deactivate();
    this.activeTool = next;
    next.activate();
  }

  isActive(id: TId): boolean {
    return this.activeTool?.id === id;
  }

  destroy(): void {
    this.activeTool?.deactivate();
    this.activeTool = null;
    this.tools.clear();
  }
}
