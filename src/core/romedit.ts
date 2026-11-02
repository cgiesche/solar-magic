// The ROM edit session: everything that changes the ROM goes through it as one labelled edit. It owns the
// protocol around a write, so callers only say "this is one undoable edit named X":
// - before the edit, `prepare` runs (the editor stores the open level there; not part of the step);
// - the edit is all or nothing: when it throws or reports failure (returns `{ ok: false }`), the ROM
//   image and the editor data are put back and no undo step is recorded;
// - afterwards (and after undo/redo) each follow-up runs whose read ROM bytes the edit changed (they are recorded
//   before it, romdeps.ts record), so callers never send notifications themselves;
// - once the edit (also one that failed or changed nothing) or undo/redo and its follow-ups are done, `settled` runs:
//   what depends on the ROM and the open level together is checked there, not by the order of the follow-ups. While
//   an edit runs (its prepare and follow-ups too), the session is `running`.
// Edits started while another one is open are part of it (one step, follow-ups once at the end); a
// failing inner edit only puts back its own part.

import type { Rom } from './rom.ts';
import { RomHistory, type RomEdit } from './romhistory.ts';
import { record, holds, type Recorded } from './romdeps.ts';

// a consequence of a ROM edit: `read` what it depends on (the ROM bytes it reads are recorded before the edit);
// `changed` when the edit changed one of them – with `same`, only when what is read now isn't the same as before (a
// follow-up that costs much when told for nothing: compared only once a byte read changed)
export interface FollowUp {
  read(rom: Rom): unknown;
  same?(before: unknown, now: unknown): boolean;
  changed(): void;
}

export interface EditHooks {
  prepare?(): void;
  // the ROM was changed by an edit (recorded: a new undo step, not merged into the last) or by undo/redo;
  // runs before the follow-ups
  written?(w: { label: string; recorded: boolean }): void;
  followUps?: FollowUp[];
  // an edit or undo/redo is done, its follow-ups too (see above)
  settled?(): void;
}

export interface EditOptions {
  key?: string | null; // quick edits with the same key merge into one step (slider drags, strokes)
  record?: boolean; // false: not undoable (written outside the history, e.g. expanding the ROM)
}

// what an edit function reports as failure
export function failed(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
}

// runs fn: when it throws or fails, `back` runs (and the error is passed on), else `keep`
function guard<T>(fn: () => T, back: () => void, keep: () => void): T {
  let v: T;
  try { v = fn(); } catch (e) { back(); throw e; }
  if (failed(v)) back(); else keep();
  return v;
}
async function guardAsync<T>(fn: () => Promise<T>, back: () => void, keep: () => void): Promise<T> {
  let v: T;
  try { v = await fn(); } catch (e) { back(); throw e; }
  if (failed(v)) back(); else keep();
  return v;
}

// runs fn; when it throws or fails, the ROM and editor data are as before
export function allOrNothing<T>(rom: Rom, fn: () => T): T {
  const s = rom.snapshot();
  return guard(fn, () => rom.restore(s), () => {});
}

export class RomEditSession {
  readonly rom: Rom;
  readonly history: RomHistory;
  private hooks: EditHooks;
  private depth = 0;
  private active = 0; // an outermost edit or an undo/redo, from its prepare to its follow-ups

  constructor(rom: Rom, hooks: EditHooks = {}, history = new RomHistory(rom)) {
    this.rom = rom;
    this.hooks = hooks;
    this.history = history;
  }

  edit<T>(label: string, fn: () => T, opt: EditOptions = {}): T {
    const run = this.start(label, opt);
    return guard(() => this.inner(fn), run.rollback, run.finish);
  }

  // edit for a change that awaits (AddmusicK inserting songs): one step for all of it
  editAsync<T>(label: string, fn: () => Promise<T>, opt: EditOptions = {}): Promise<T> {
    const run = this.start(label, opt);
    return guardAsync(() => this.innerAsync(fn), run.rollback, run.finish);
  }

  // undoes the last step (null: none); throws when it can't (see RomHistory.undo)
  undo(): RomEdit | null {
    return this.step(() => this.history.undo());
  }

  redo(): RomEdit | null {
    return this.step(() => this.history.redo());
  }

  // an edit is under way (also its prepare and follow-ups): settled runs once it is done
  get running(): boolean { return this.active > 0; }

  private step(f: () => RomEdit | null): RomEdit | null {
    this.active++;
    try {
      const before = this.readAll();
      const e = f();
      if (e) this.done(e.label, false, before);
      return e;
    } finally { this.settle(); }
  }

  private settle(): void {
    if (--this.active) return;
    try { this.hooks.settled?.(); } catch (e) { console.error(e); }
  }

  private inner<T>(fn: () => T): T {
    this.depth++;
    try { return fn(); } finally { this.depth--; }
  }

  private async innerAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    try { return await fn(); } finally { this.depth--; }
  }

  // how an edit ends: put back or kept (an inner edit: its own part put back, the rest is the outer's)
  private start(label: string, opt: EditOptions): { rollback: () => void; finish: () => void } {
    if (this.depth || this.history.open) {
      const s = this.rom.snapshot();
      return { rollback: () => this.rom.restore(s), finish: () => {} };
    }
    this.active++;
    let before: Recorded<unknown>[];
    try {
      this.hooks.prepare?.();
      before = this.readAll();
    } catch (e) { this.settle(); throw e; }
    const h = this.history, record = opt.record !== false;
    const snap = record ? null : this.rom.snapshot();
    const gen = this.rom.gen, pushes = h.pushes;
    if (record) h.begin(label, opt.key ?? null);
    return {
      rollback: () => {
        try { if (snap) this.rom.restore(snap); else h.rollback(); } finally { this.settle(); }
      },
      finish: () => {
        try {
          const changed = record ? h.commit() !== null : this.rom.gen !== gen;
          if (changed) this.done(label, h.pushes !== pushes, before);
        } finally { this.settle(); }
      },
    };
  }

  // what the follow-ups read, recorded (not counted for a recording around the edit)
  private readAll(): Recorded<unknown>[] {
    return (this.hooks.followUps ?? []).map((f) => record(this.rom, () => f.read(this.rom), { counted: false }));
  }

  private done(label: string, recorded: boolean, before: Recorded<unknown>[]): void {
    this.hooks.written?.({ label, recorded });
    // (the edit is done either way: a failing follow-up is reported, not passed on to the caller)
    (this.hooks.followUps ?? []).forEach((f, i) => {
      try { if (!holds(this.rom, before[i]) && !f.same?.(before[i].result, f.read(this.rom))) f.changed(); } catch (e) { console.error(e); }
    });
  }
}
