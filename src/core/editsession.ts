// The edit session: the open level and everything that changes it or the ROM. It owns
// - the open level and whether it has unsaved changes (dirty);
// - the level history (level edits: begun, then committed as an undo step or cancelled);
// - the ROM edit session (romedit.ts), which saves a dirty level before every ROM edit;
// - the order of level and ROM edits, so one undo/redo serves both. Steps a history dropped beyond its
//   limit are passed over.
// Callers are told through hooks; the view (drawing, events, messages) is theirs.

import type { Rom } from './rom.ts';
import { type Level, loadLevel, cloneLevel, spriteLoadOrder, isL1Vertical } from './level.ts';
import { saveLevel } from './save.ts';
import { LevelHistory } from './levelhistory.ts';
import { RomEditSession, type EditOptions, type FollowUp } from './romedit.ts';
import type { RomHistory, RomEdit } from './romhistory.ts';

const ORDER_LIMIT = 400;

// an undoable level edit begun with beginLevelEdit
export interface LevelEdit {
  commit(rerender?: boolean): void;
  cancel(restore?: boolean): void;
}

// what an undo or redo did (null: nothing to do)
export type StepResult =
  | { kind: 'level' }
  | { kind: 'rom'; edit: RomEdit }
  | { kind: 'failed'; error: unknown }; // a ROM step that could not be undone/redone (see RomHistory.undo)

export interface SessionHooks {
  // the open level was edited, undone or redone (rerender false: the caller draws it itself)
  changed?(rerender: boolean): void;
  // the open level was saved to the ROM (and loaded again); log: what saving did
  saved?(log: string[], silent: boolean): void;
  saveFailed?(error: unknown): void;
  // see EditHooks.written (romedit.ts)
  written?(w: { label: string; recorded: boolean }): void;
  followUps?: FollowUp[];
}

export class EditSession {
  readonly rom: Rom;
  readonly romEdits: RomEditSession;
  level!: Level;
  dirty = false;
  levelGen = 0; // counts committed level edits (not undo/redo/loading)
  private levelHistory = new LevelHistory<Level>(cloneLevel);
  private editToken = 0; // the latest begun level edit (older handles do nothing)
  // order of level and ROM edits (n: stack length after the push)
  private undoOrder: { kind: 'level' | 'rom'; n: number }[] = [];
  private redoOrder: ('level' | 'rom')[] = [];
  private hooks: SessionHooks;

  constructor(rom: Rom, hooks: SessionHooks = {}) {
    this.rom = rom;
    this.hooks = hooks;
    this.romEdits = new RomEditSession(rom, {
      prepare: () => { if (this.level && this.dirty) this.save(true); },
      written: (w) => {
        if (w.recorded) this.pushOrder('rom', this.romHistory.undoStack.length);
        this.hooks.written?.(w);
      },
      followUps: hooks.followUps,
    });
  }

  get romHistory(): RomHistory { return this.romEdits.history; }
  // the kind of the latest step undo would take back
  get lastStep(): 'level' | 'rom' | null { return this.undoOrder[this.undoOrder.length - 1]?.kind ?? null; }

  // opens level n (the dirty one saved first) with a new level history
  open(n: number): void {
    if (this.level && this.dirty) this.save(true);
    this.level = loadLevel(this.rom, n);
    this.levelHistory.clear();
    this.dirty = false;
  }

  // saves the open level and loads it again (addresses and sizes); objects and sprites keep their ids
  save(silent = false): boolean {
    try {
      const log = saveLevel(this.rom, this.level);
      this.dirty = false;
      const was = this.level;
      this.level = loadLevel(this.rom, was.number);
      keepUids(was, this.level, isL1Vertical(this.rom, this.level.header.mode));
      this.hooks.saved?.(log, silent);
      return true;
    } catch (e) {
      this.hooks.saveFailed?.(e);
      return false;
    }
  }

  // ------------- level edits -------------
  // An undoable level edit: begun before the level changes, then committed (an undo step; the level is
  // drawn again unless rerender is false) or cancelled (nothing recorded, redo stays; restore: the
  // level as before, after a failed change). For edits spanning several events (dragging).
  beginLevelEdit(): LevelEdit {
    if (this.levelHistory.begin(this.level)) this.levelEditDone();
    const token = ++this.editToken;
    const live = () => token === this.editToken && this.levelHistory.editing;
    return {
      commit: (rerender = true) => {
        if (!live()) return;
        this.commitLevelEdit();
        this.changed(rerender);
      },
      cancel: (restore = false) => {
        if (!live()) return;
        const was = this.levelHistory.cancel();
        if (restore && was) { this.level = was; this.changed(true); }
      },
    };
  }

  // A level edit at once: f changes the open level it is given (not one held from before: a ROM edit saves a
  // changed level, which loads it anew), returns false when it changed nothing (cancelled); when it throws,
  // the level is as before and the error passed on. True when committed.
  editLevel(f: (lv: Level) => boolean | void, rerender = true): boolean {
    const e = this.beginLevelEdit();
    let ok: boolean;
    try { ok = f(this.level) !== false; } catch (err) { e.cancel(true); throw err; }
    if (ok) e.commit(rerender); else e.cancel();
    return ok;
  }

  // the open level changed (outside an edit too, e.g. as part of the latest step)
  changed(rerender: boolean): void {
    this.dirty = true;
    this.hooks.changed?.(rerender);
  }

  // ------------- ROM edits -------------
  // One undoable ROM edit (see romedit.ts): a dirty level is saved before it.
  romEdit<T>(label: string, fn: () => T, opt: EditOptions = {}): T {
    return this.romEdits.edit(label, fn, opt);
  }

  romEditAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return this.romEdits.editAsync(label, fn);
  }

  // ------------- undo / redo -------------
  // undoes the latest level or ROM edit
  undo(): StepResult | null {
    this.commitLevelEdit(); // (an edit still open, e.g. while dragging)
    while (this.undoOrder.length) {
      const o = this.undoOrder.pop()!;
      const len = o.kind === 'level' ? this.levelHistory.undoSize : this.romHistory.undoStack.length;
      if (o.n > len || len === 0) continue; // dropped history (beyond the limit)
      if (o.kind === 'rom') {
        const r = this.romStep(true);
        if (r?.kind === 'rom') this.redoOrder.push('rom');
        return r;
      }
      this.levelStep(true);
      this.redoOrder.push('level');
      return { kind: 'level' };
    }
    return this.levelStep(true) ? { kind: 'level' } : null;
  }

  redo(): StepResult | null {
    this.commitLevelEdit();
    while (this.redoOrder.length) {
      const k = this.redoOrder.pop()!;
      if (k === 'rom') {
        if (!this.romHistory.redoStack.length) continue;
        const r = this.romStep(false);
        if (r?.kind === 'rom') this.undoOrder.push({ kind: 'rom', n: this.romHistory.undoStack.length });
        return r;
      }
      if (!this.levelHistory.redoSize) continue;
      this.levelStep(false);
      this.undoOrder.push({ kind: 'level', n: this.levelHistory.undoSize });
      return { kind: 'level' };
    }
    return this.levelStep(false) ? { kind: 'level' } : null;
  }

  private commitLevelEdit(): void {
    if (this.levelHistory.commit()) this.levelEditDone();
  }

  private levelEditDone(): void {
    this.levelGen++;
    this.pushOrder('level', this.levelHistory.undoSize);
  }

  private pushOrder(kind: 'level' | 'rom', n: number): void {
    this.undoOrder.push({ kind, n });
    if (this.undoOrder.length > ORDER_LIMIT) this.undoOrder.shift();
    this.redoOrder = [];
  }

  private levelStep(undo: boolean): boolean {
    const lv = undo ? this.levelHistory.undo(this.level) : this.levelHistory.redo(this.level);
    if (!lv) return false;
    this.level = lv;
    this.changed(true);
    return true;
  }

  private romStep(undo: boolean): StepResult | null {
    try {
      const e = undo ? this.romEdits.undo() : this.romEdits.redo();
      return e && { kind: 'rom', edit: e };
    } catch (error) {
      return { kind: 'failed', error };
    }
  }
}

// the ids of a level's objects and sprites onto the same level loaded again (sprites are stored in load
// order); when the counts differ, the new ones stay
function keepUids(from: Level, to: Level, vertical: boolean): void {
  const copy = <T extends { uid: number }>(a: T[] | null, b: T[] | null) => {
    if (a && b && a.length === b.length) a.forEach((x, i) => { b[i].uid = x.uid; });
  };
  copy(from.objects, to.objects);
  copy(from.layer2Objects, to.layer2Objects);
  copy(spriteLoadOrder(from.sprites, vertical), to.sprites);
}
