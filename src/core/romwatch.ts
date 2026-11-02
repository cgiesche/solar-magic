// Views subscribed to the ROM bytes they read: a view draws through its Watch (run), which records what the drawing
// read (romdeps.ts record); after a ROM change (notify) a watch is told only when a byte it read changed. A watch
// held (a stroke being drawn) is told nothing while held, and while any is held the ROM's other followers wait
// (held: the level's re-emulation would stall the stroke). A ROM edit the view makes itself (own) is taken as seen:
// what it draws is already as edited.

import type { Rom } from './rom.ts';
import { record, holds, type Recorded } from './romdeps.ts';

export class Watch {
  private seen: Recorded<unknown> | null = null; // what it drew last read (null: nothing watched)
  private holding = false;
  private owning = 0;
  private owner: RomWatch;
  private changed: () => void;

  constructor(owner: RomWatch, changed: () => void) {
    this.owner = owner;
    this.changed = changed;
  }

  // runs fn (the view's drawing), watching what it reads from then on instead of what was watched before
  run<T>(fn: () => T): T {
    const r = record(this.owner.rom, fn, { counted: false });
    this.seen = r;
    return r.result;
  }

  // watches nothing until run again (a view hidden)
  stop(): void { this.seen = null; }

  // while held (a stroke being drawn) the watch is told nothing and the ROM's other followers wait (RomWatch.held);
  // a change meanwhile is told at the next notify after release, unless an own edit follows first
  hold(): void { this.holding = true; }
  release(): void { this.holding = false; }
  get held(): boolean { return this.holding; }

  // a ROM edit the view makes itself: not told about it, what it watches is as of the edit's end (the view drew it)
  own<T>(fn: () => T): T {
    this.owning++;
    try { return fn(); } finally {
      this.owning--;
      if (this.seen) this.seen.gen = this.owner.rom.gen;
    }
  }

  // (RomWatch.notify) told when a byte it read changed; once told it watches nothing until run again
  check(): void {
    if (!this.seen || this.holding || this.owning || holds(this.owner.rom, this.seen)) return;
    this.seen = null;
    this.changed();
  }
}

export class RomWatch {
  readonly rom: Rom;
  private watches = new Set<Watch>();

  constructor(rom: Rom) {
    this.rom = rom;
  }

  // a watch telling changed when a byte read by its latest run changed; it watches nothing until run
  watch(changed: () => void): Watch {
    const w = new Watch(this, changed);
    this.watches.add(w);
    return w;
  }

  // the ROM changed: each watch whose read bytes changed is told (one failing doesn't keep the others from it)
  notify(): void {
    for (const w of [...this.watches]) {
      try { w.check(); } catch (e) { console.error(e); }
    }
  }

  // a watch is held (a stroke being drawn): the ROM's other followers wait
  get held(): boolean {
    for (const w of this.watches) if (w.held) return true;
    return false;
  }
}
