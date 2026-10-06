// Undo/redo for ROM edits (palettes, Map16, graphics, slot assignments): each edit stores the bytes it
// changed (diff against a copy taken before). An edit is only undone while its bytes are still as it left
// them, so edits made elsewhere in between (level saves reusing freed space) are never clobbered.

import type { Rom } from './rom.ts';

interface Run { off: number; old: Uint8Array; neu: Uint8Array }
export interface RomEdit {
  label: string;
  runs: Run[];
  // ROM size changed (expansion): whole ROM before/after instead of runs
  whole: { before: Uint8Array; after: Uint8Array } | null;
  extra?: { before: Map<string, Uint8Array>; after: Map<string, Uint8Array> }; // the editor data changed (sources of patches)
  key: string | null; // edits with the same key in quick succession merge into one
  time: number;
}

const MERGE_MS = 1500;
const MERGE_MAX = 0x10000; // bytes; larger edits are kept apart

function diff(a: Uint8Array, b: Uint8Array): Run[] {
  const runs: Run[] = [];
  const n = a.length;
  const words = n % 4 === 0 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0;
  const wa = words ? new Uint32Array(a.buffer, a.byteOffset, n >> 2) : null;
  const wb = words ? new Uint32Array(b.buffer, b.byteOffset, n >> 2) : null;
  let i = 0;
  while (i < n) {
    if (wa && wb && (i & 3) === 0) {
      let k = i >> 2;
      while (k < wa.length && wa[k] === wb[k]) k++;
      i = k << 2;
      if (i >= n) break;
    }
    if (a[i] === b[i]) { i++; continue; }
    const s = i;
    // close gaps of up to 8 equal bytes into one run
    let e = i + 1, same = 0;
    while (e < n && same <= 8) { if (a[e] === b[e]) same++; else same = 0; e++; }
    e -= same;
    runs.push({ off: s, old: a.slice(s, e), neu: b.slice(s, e) });
    i = e;
  }
  return runs;
}

// the checksum ($7FDC-$7FDF) is rewritten whenever the ROM is written out, so it does not count
const isChecksum = (o: number) => o >= 0x7fdc && o <= 0x7fdf;
function matches(data: Uint8Array, off: number, bytes: Uint8Array): boolean {
  if (off + bytes.length > data.length) return false;
  for (let i = 0; i < bytes.length; i++) if (data[off + i] !== bytes[i] && !isChecksum(off + i)) return false;
  return true;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && matches(a, 0, b);
}

// same entries (blobs are never changed in place, so identity is enough)
function sameMap(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function size(e: RomEdit): number {
  return e.runs.reduce((s, r) => s + r.old.length, 0);
}

// second edit applied after the first, as one edit
function merge(a: RomEdit, b: RomEdit): RomEdit {
  const m = new Map<number, [number, number]>();
  for (const r of a.runs) for (let i = 0; i < r.old.length; i++) m.set(r.off + i, [r.old[i], r.neu[i]]);
  for (const r of b.runs) for (let i = 0; i < r.old.length; i++) {
    const p = m.get(r.off + i);
    m.set(r.off + i, [p ? p[0] : r.old[i], r.neu[i]]);
  }
  const offs = [...m.keys()].sort((x, y) => x - y);
  const runs: Run[] = [];
  let k = 0;
  while (k < offs.length) {
    let e = k + 1;
    while (e < offs.length && offs[e] === offs[e - 1] + 1) e++;
    const len = e - k;
    const run = { off: offs[k], old: new Uint8Array(len), neu: new Uint8Array(len) };
    for (let i = 0; i < len; i++) { const v = m.get(offs[k + i])!; run.old[i] = v[0]; run.neu[i] = v[1]; }
    if (!equal(run.old, run.neu)) runs.push(run);
    k = e;
  }
  return { ...b, runs, label: a.label };
}

export class RomHistory {
  undoStack: RomEdit[] = [];
  redoStack: RomEdit[] = [];
  private snap: Uint8Array | null = null;
  private snapExtra: Map<string, Uint8Array> | null = null;
  private depth = 0;
  private label = '';
  private key: string | null = null;
  pushes = 0; // counts recorded (not merged) edits
  rom: Rom;
  limit: number;

  constructor(rom: Rom, limit = 200) {
    this.rom = rom;
    this.limit = limit;
  }

  get open(): boolean {
    return this.depth > 0;
  }

  // nested begin/commit pairs form one edit (the outermost label counts)
  begin(label: string, key: string | null = null): void {
    if (this.depth++ === 0) {
      this.snap = this.rom.data.slice();
      this.snapExtra = new Map(this.rom.extra);
      this.label = label;
      this.key = key;
    }
  }

  // closes the edit; returns it when it changed anything
  commit(): RomEdit | null {
    if (this.depth === 0) return null;
    if (--this.depth > 0) return null;
    const before = this.snap!, beforeExtra = this.snapExtra!;
    this.snap = null;
    this.snapExtra = null;
    const now = this.rom.data;
    const extra = sameMap(beforeExtra, this.rom.extra) ? undefined : { before: beforeExtra, after: new Map(this.rom.extra) };
    let e: RomEdit;
    if (before.length !== now.length) e = { label: this.label, runs: [], whole: { before, after: now.slice() }, key: null, time: Date.now() };
    else {
      const runs = diff(before, now);
      if (!runs.length && !extra) return null;
      e = { label: this.label, runs, whole: null, key: extra ? null : this.key, time: Date.now() };
    }
    if (extra) e.extra = extra;
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && e.key && last.key === e.key && !last.whole && !e.whole && e.time - last.time < MERGE_MS && size(last) + size(e) <= MERGE_MAX) {
      this.undoStack[this.undoStack.length - 1] = merge(last, e);
    } else {
      this.undoStack.push(e);
      this.pushes++;
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack = [];
    return e;
  }

  // drops an open edit without recording it (the ROM keeps its changes)
  cancel(): void {
    this.depth = 0;
    this.snap = null;
    this.snapExtra = null;
  }

  edit<T>(label: string, fn: () => T, key: string | null = null): T {
    this.begin(label, key);
    try { return fn(); } finally { this.commit(); }
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.cancel();
  }

  private applies(e: RomEdit, forward: boolean): boolean {
    const d = this.rom.data;
    if (e.whole) return equal(d, forward ? e.whole.before : e.whole.after);
    return e.runs.every((r) => matches(d, r.off, forward ? r.old : r.neu));
  }

  private apply(e: RomEdit, forward: boolean): void {
    if (e.extra) this.rom.extra = new Map(forward ? e.extra.after : e.extra.before);
    if (e.whole) { this.rom.data = (forward ? e.whole.after : e.whole.before).slice(); return; }
    for (const r of e.runs) this.rom.data.set(forward ? r.neu : r.old, r.off);
  }

  // undoes the last edit; null when there is none. Throws when the ROM changed elsewhere since
  // (the history is dropped then).
  undo(): RomEdit | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    if (!this.applies(e, false)) {
      this.undoStack = [];
      this.redoStack = [];
      throw new Error(`“${e.label}” cannot be undone: the ROM has since been changed differently at the same place`);
    }
    this.apply(e, false);
    this.redoStack.push(e);
    return e;
  }

  redo(): RomEdit | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    if (!this.applies(e, true)) {
      this.redoStack = [];
      throw new Error(`“${e.label}” cannot be redone: the ROM has changed since`);
    }
    this.apply(e, true);
    e.key = null; // a redone edit never merges with the next one
    this.undoStack.push(e);
    return e;
  }
}
