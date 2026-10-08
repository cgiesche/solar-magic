// Undo/redo of level edits: a copy of the level from before each edit. An edit is begun (the copy is
// taken) and then committed (the copy becomes an undo step, redo is dropped) or cancelled (nothing is
// recorded, redo stays) – so an edit that turns out to change nothing (a click without dragging, a
// failed insert) leaves the history as it was. Beginning while one is open commits that one first.
// Generic over the level type (clone: a deep copy); the editor interleaves it with the ROM history.

export class LevelHistory<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private open: T | null = null; // the copy of an edit begun and not committed or cancelled yet
  private clone: (t: T) => T;
  private limit: number;

  constructor(clone: (t: T) => T, limit = 200) {
    this.clone = clone;
    this.limit = limit;
  }

  get undoSize(): number { return this.undoStack.length; }
  get redoSize(): number { return this.redoStack.length; }
  get editing(): boolean { return this.open !== null; }

  // an edit of `cur` starts; true when an open one was committed for it
  begin(cur: T): boolean {
    const committed = this.commit();
    this.open = this.clone(cur);
    return committed;
  }

  // the open edit becomes an undo step; false when none is open
  commit(): boolean {
    if (this.open === null) return false;
    this.undoStack.push(this.open);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.open = null;
    return true;
  }

  // the open edit is dropped; returns the level as it was before it (null when none is open)
  cancel(): T | null {
    const was = this.open;
    this.open = null;
    return was;
  }

  // the level before the last edit (cur goes to redo); null when there is nothing to undo
  undo(cur: T): T | null {
    this.commit();
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(this.clone(cur));
    return prev;
  }

  redo(cur: T): T | null {
    this.commit();
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.clone(cur));
    return next;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = null;
  }
}
