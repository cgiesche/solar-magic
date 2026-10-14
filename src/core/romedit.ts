// The ROM edit session: everything that changes the ROM goes through it as one labelled edit. It owns the
// protocol around a write, so callers only say "this is one undoable edit named X":
// - before the edit, `prepare` runs (the editor stores the open level there; not part of the step);
// - the edit is all or nothing: when it throws or reports failure (returns `{ ok: false }`), the ROM
//   image and the editor data are put back and no undo step is recorded;
// - afterwards (and after undo/redo) each follow-up whose data differs from before runs, so callers
//   never send notifications themselves.
// Edits started while another one is open are part of it (one step, follow-ups once at the end); a
// failing inner edit only puts back its own part.

import type { Rom } from './rom.ts';
import { RomHistory, type RomEdit } from './romhistory.ts';

// a consequence of a ROM edit: `read` what it depends on before and after; `changed` when it differs
export interface FollowUp {
  read(rom: Rom): string;
  changed(): void;
}

export interface EditHooks {
  prepare?(): void;
  // the ROM was changed by an edit (recorded: a new undo step, not merged into the last) or by undo/redo;
  // runs before the follow-ups
  written?(w: { label: string; recorded: boolean }): void;
  followUps?: FollowUp[];
}

export interface EditOptions {
  key?: string | null; // quick edits with the same key merge into one step (slider drags, strokes)
  record?: boolean; // false: not undoable (written outside the history, e.g. the overworld's own save)
}

// what an edit function reports as failure
export function failed(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
}

// runs fn; when it throws or fails, the ROM and editor data are as before
export function allOrNothing<T>(rom: Rom, fn: () => T): T {
  const s = rom.snapshot();
  let v: T;
  try { v = fn(); } catch (e) { rom.restore(s); throw e; }
  if (failed(v)) rom.restore(s);
  return v;
}

export class RomEditSession {
  readonly rom: Rom;
  readonly history: RomHistory;
  private hooks: EditHooks;
  private depth = 0;

  constructor(rom: Rom, hooks: EditHooks = {}, history = new RomHistory(rom)) {
    this.rom = rom;
    this.hooks = hooks;
    this.history = history;
  }

  edit<T>(label: string, fn: () => T, opt: EditOptions = {}): T {
    if (this.depth || this.history.open) return this.inner(() => allOrNothing(this.rom, fn));
    const run = this.start(label, opt);
    let v: T;
    try { v = this.inner(fn); } catch (e) { run.rollback(); throw e; }
    if (failed(v)) run.rollback(); else run.finish();
    return v;
  }

  // edit for a change that awaits (AddmusicK inserting songs): one step for all of it
  async editAsync<T>(label: string, fn: () => Promise<T>, opt: EditOptions = {}): Promise<T> {
    if (this.depth || this.history.open) {
      const s = this.rom.snapshot();
      let v: T;
      try { v = await this.innerAsync(fn); } catch (e) { this.rom.restore(s); throw e; }
      if (failed(v)) this.rom.restore(s);
      return v;
    }
    const run = this.start(label, opt);
    let v: T;
    try { v = await this.innerAsync(fn); } catch (e) { run.rollback(); throw e; }
    if (failed(v)) run.rollback(); else run.finish();
    return v;
  }

  // undoes the last step (null: none); throws when it can't (see RomHistory.undo)
  undo(): RomEdit | null {
    return this.step(() => this.history.undo());
  }

  redo(): RomEdit | null {
    return this.step(() => this.history.redo());
  }

  private step(f: () => RomEdit | null): RomEdit | null {
    const before = this.readAll();
    const e = f();
    if (e) this.done(e.label, false, before);
    return e;
  }

  private inner<T>(fn: () => T): T {
    this.depth++;
    try { return fn(); } finally { this.depth--; }
  }

  private async innerAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    try { return await fn(); } finally { this.depth--; }
  }

  private start(label: string, opt: EditOptions) {
    this.hooks.prepare?.();
    const before = this.readAll();
    const h = this.history, record = opt.record !== false;
    const snap = record ? null : this.rom.snapshot();
    const gen = this.rom.gen, pushes = h.pushes;
    if (record) h.begin(label, opt.key ?? null);
    return {
      rollback: () => { if (snap) this.rom.restore(snap); else h.rollback(); },
      finish: () => {
        const changed = record ? h.commit() !== null : this.rom.gen !== gen;
        if (changed) this.done(label, h.pushes !== pushes, before);
      },
    };
  }

  private readAll(): string[] {
    return (this.hooks.followUps ?? []).map((f) => f.read(this.rom));
  }

  private done(label: string, recorded: boolean, before: string[]): void {
    this.hooks.written?.({ label, recorded });
    (this.hooks.followUps ?? []).forEach((f, i) => { if (f.read(this.rom) !== before[i]) f.changed(); });
  }
}
