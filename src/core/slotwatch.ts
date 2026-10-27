// Test play's slot meter: how many slots of the sprite tables are live, and the slot searches that found
// every slot they looked at taken – a sprite that failed to spawn (or, where the code then takes a slot
// anyway, one that replaced another). Learned from what the code does, not from the game's tables (which
// slots a sprite memory gives level sprites, which slots are kept for what): a slot search is a loop
// reading consecutive slots of a table, each read tested for zero by the next instruction (BEQ / BNE), with
// nothing between the reads but its bound in scratch RAM. Loops over the slots that are no search do more
// (read the sprite's number, compare its status). A search through a few slots kept for something (Mario's
// fireballs: 2 of the 10 extended slots) is no shortage of the table and doesn't count.

import type { Snes, MemHook } from './snes.ts';
import { RAM, SPR, SPRITE_SLOTS, EXT_SLOTS, CLUSTER_SLOTS } from './ram.ts';

export type SlotKind = 'sprite' | 'extended' | 'cluster';
export const SLOT_TABLES: Record<SlotKind, { base: number; slots: number }> = {
  sprite: { base: SPR.status, slots: SPRITE_SLOTS },
  extended: { base: RAM.extSprites, slots: EXT_SLOTS },
  cluster: { base: RAM.clusterSprites, slots: CLUSTER_SLOTS },
};
export const SLOT_KINDS = Object.keys(SLOT_TABLES) as SlotKind[];
// a failed search: the slots it looked at (all taken), the table's slots free elsewhere then (the code
// may use only some of them: a sprite memory's for level sprites, a generator's own); replaced: the code
// then took a taken slot anyway (the game's extended sprites, by a rotating index), its sprite vanished
export interface SlotFailure { kind: SlotKind; searched: number; free: number; replaced: boolean }

const BEQ = 0xf0, BNE = 0xd0;
const INTERRUPT = 4; // bytes an interrupt pushes (native mode): deeper on the stack, the search is interrupted
const REPLACE_CYCLES = 200; // how soon after the failed search a write to a taken slot is its replacement

interface Run { kind: SlotKind; pc: number; sp: number; last: number; dir: number; count: number }

export class SlotWatch {
  readonly hook: MemHook;
  private failed: SlotFailure[] = [];
  private run: Run | null = null;
  // the latest failure, while a write may still take a slot that was taken then
  private after: { f: SlotFailure; taken: boolean[]; until: number } | null = null;
  private s: Snes;

  constructor(s: Snes) {
    this.s = s;
    this.hook = {
      onWramRead: (a) => this.read(a),
      onWramWrite: (a, v) => {
        if (this.run && !this.aside(a)) this.end();
        if (this.after) this.written(a, v);
      },
    };
  }

  // live slots of a table
  used(kind: SlotKind): number {
    const t = SLOT_TABLES[kind], w = this.s.wram;
    let n = 0;
    for (let i = 0; i < t.slots; i++) if (w[t.base + i]) n++;
    return n;
  }

  usedAll(): Record<SlotKind, number> {
    return Object.fromEntries(SLOT_KINDS.map((k) => [k, this.used(k)])) as Record<SlotKind, number>;
  }

  // the searches that failed since the last call
  take(): SlotFailure[] {
    const f = this.failed;
    this.failed = [];
    return f;
  }

  // the machine's state was replaced (a savestate loaded): a search in progress is gone
  reset(): void {
    this.run = null;
    this.after = null;
    this.failed = [];
  }

  // a write after a failed search: into a slot taken then, the search's sprite replaced the one there
  private written(a: number, v: number): void {
    const { f, taken, until } = this.after!;
    if (this.s.cpu.cycles > until) { this.after = null; return; }
    if (tableOf(a) !== f.kind) return;
    f.replaced = v !== 0 && taken[a - SLOT_TABLES[f.kind].base];
    this.after = null;
  }

  // an access that isn't the search's own: the stack, or anything in an interrupt
  private aside(a: number): boolean {
    return (a >= RAM.stack && a < RAM.stackEnd) || this.s.cpu.s < this.run!.sp - (INTERRUPT - 1);
  }

  private read(a: number): void {
    const run = this.run;
    if (run && this.aside(a)) return;
    const kind = tableOf(a);
    if (kind === null) {
      if (run && a >= RAM.scratchEnd) this.end(); // a search keeps its bound in scratch RAM
      return;
    }
    const cpu = this.s.cpu, next = this.s.peek((cpu.pbr << 16) | cpu.pc);
    if (next !== BEQ && next !== BNE) {
      if (run) this.end();
      return;
    }
    const i = a - SLOT_TABLES[kind].base, d = run ? i - run.last : 0;
    let r: Run;
    if (run && run.kind === kind && run.pc === cpu.opPc && (d === 1 || d === -1) && (run.dir === 0 || d === run.dir)) {
      r = run;
      r.dir = d;
    } else {
      if (run) this.end();
      r = this.run = { kind, pc: cpu.opPc, sp: cpu.s, last: i, dir: 0, count: 0 };
    }
    if (!this.s.wram[a]) { this.run = null; return; } // found a free slot
    r.last = i;
    r.count++;
  }

  // the loop is left: it failed when every slot it read was taken and they were more than a few
  private end(): void {
    const r = this.run!;
    this.run = null;
    const t = SLOT_TABLES[r.kind];
    if (r.count < Math.ceil(t.slots / 3)) return;
    const f = { kind: r.kind, searched: r.count, free: t.slots - this.used(r.kind), replaced: false };
    this.failed.push(f);
    const w = this.s.wram, taken = Array.from({ length: t.slots }, (_, i) => w[t.base + i] !== 0);
    this.after = { f, taken, until: this.s.cpu.cycles + REPLACE_CYCLES };
  }
}

function tableOf(a: number): SlotKind | null {
  for (const k of SLOT_KINDS) {
    const t = SLOT_TABLES[k];
    if (a >= t.base && a < t.base + t.slots) return k;
  }
  return null;
}
