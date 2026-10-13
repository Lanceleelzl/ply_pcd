export interface EditStep<T> { label: string; state: T; at: number }

/** Immutable snapshots make the cursor independent of component lifetime. */
export class EditHistory<T> {
  private steps: EditStep<T>[];
  private index = 0;

  constructor(initial: T, private readonly clone: (value: T) => T) {
    this.steps = [{ label: '导入模型', state: clone(initial), at: Date.now() }];
  }

  get entries(): readonly EditStep<T>[] { return this.steps; }
  get cursor(): number { return this.index; }
  get current(): T { return this.clone(this.steps[this.index].state); }
  get canUndo(): boolean { return this.index > 0; }
  get canRedo(): boolean { return this.index < this.steps.length - 1; }

  record(label: string, state: T): void {
    this.steps = this.steps.slice(0, this.index + 1);
    this.steps.push({ label, state: this.clone(state), at: Date.now() });
    this.index = this.steps.length - 1;
  }

  jump(index: number): T {
    if (!Number.isInteger(index) || index < 0 || index >= this.steps.length) throw new RangeError('Invalid edit history step');
    this.index = index;
    return this.current;
  }

  undo(): T { return this.jump(Math.max(0, this.index - 1)); }
  redo(): T { return this.jump(Math.min(this.steps.length - 1, this.index + 1)); }

  serialize(): { steps: EditStep<T>[]; cursor: number } {
    return { steps: this.steps.map(step => ({ ...step, state: this.clone(step.state) })), cursor: this.index };
  }

  restore(value: { steps: EditStep<T>[]; cursor: number }): void {
    if (!value.steps.length || !Number.isInteger(value.cursor) || value.cursor < 0 || value.cursor >= value.steps.length) {
      throw new RangeError('Invalid edit history');
    }
    this.steps = value.steps.map(step => ({ ...step, state: this.clone(step.state) }));
    this.index = value.cursor;
  }
}
