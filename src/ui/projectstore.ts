// When the working ROM is stored in the browser (the App's one copy, storage.ts): debounced after ROM edits (they come
// in quick succession), at once after a level save, a pending store when the page is left. Closed – the project closed
// or replaced by another – it never writes again: the browser has one slot, an old project's late store would put it
// back over the new one (#499).
// The project lives in the browser only until “Save project” writes a project file (#500): a store that fails is told
// once per streak of failures (a quota or a private window fails every time), and the store knows whether the ROM
// changed since the last “Save project” – kept with the ROM, so a reload knows it too.

export interface StoreHost {
  store: () => Promise<void>;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  /** A store failed after the one before it worked. */
  failed?: (e: unknown) => void;
  /** The project has its first change since “Save project”. */
  changed?: () => void;
}

export class ProjectStore {
  private timer = 0;
  private closed = false;
  private failing = false;
  private dirty: boolean;
  private edits = 0;
  private readonly host: StoreHost;
  /** changed: whether the project as opened has changes that are in no project file. */
  constructor(host: StoreHost, changed = false) { this.host = host; this.dirty = changed; }

  get pending(): boolean { return this.timer !== 0; }

  /** After a ROM edit: stored once no other followed for a while. */
  soon(ms = 1000): void {
    if (this.closed) return;
    this.drop();
    this.timer = this.host.setTimer(() => { this.timer = 0; this.now(); }, ms);
  }
  now(): void {
    this.drop();
    if (this.closed) return;
    this.host.store().then(() => { this.failing = false; }, (e) => {
      if (this.failing || this.closed) return;
      this.failing = true;
      this.host.failed?.(e);
    });
  }
  /** The page is left: a ROM edit not stored yet. */
  flush(): void { if (this.timer) this.now(); }
  close(): void {
    this.closed = true;
    this.drop();
  }
  private drop(): void {
    if (this.timer) this.host.clearTimer(this.timer);
    this.timer = 0;
  }

  /** Whether the ROM changed since the last “Save project” (or since it was opened from a project file). */
  get changed(): boolean { return this.dirty; }
  /** Counts the ROM changes: what a project file holds is the ROM of the version it was made at. */
  get version(): number { return this.edits; }
  /** The ROM changed (a ROM edit, undo/redo, a level save). */
  touch(): void {
    if (this.closed) return;
    this.edits++;
    if (this.dirty) return;
    this.dirty = true;
    this.host.changed?.();
  }
  /** “Save project” wrote the ROM of `version` to a project file; stored at once (the state, a new name). */
  saved(version: number): void {
    if (version === this.edits) this.dirty = false;
    this.now();
  }
}

/** What closing the desktop app's window would lose (null: nothing, it closes without a question). */
export function closeWarning(levelDirty: boolean, projectChanged: boolean): string | null {
  if (levelDirty) return 'There are unsaved changes in the level.';
  if (projectChanged) return 'The project has changes that are not in a project file yet (“Save project”).';
  return null;
}
