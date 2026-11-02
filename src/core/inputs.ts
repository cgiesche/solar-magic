// Inputs of emulated results: state outside the ROM a result depends on – the level as edited, the view
// settings (switches, conditional Direct Map16 flags, ExAnimation triggers). ROM bytes are tracked by the
// emulator (romdeps.ts); an input is handed in next to the result's key and hashed canonically, so a result
// holds while its key, its input and the bytes it read are unchanged (learner.ts, ResultCache).

import type { LevelOverride } from './levelemu.ts';
import type { Level } from './level.ts';

// A 64-bit hash (two 32-bit ones) of a value: the same for equal values whatever their object identity or
// the order of keys, Set and Map entries. Typed arrays by their bytes; functions and undefined fields don't
// count.
export function inputHash(v: unknown): string {
  const h = new Hasher();
  h.value(v);
  return h.text();
}

class Hasher {
  private a = 0x811c9dc5;
  private b = 0x2545f491;

  add(v: number): void {
    this.a = Math.imul(this.a ^ v, 0x01000193);
    this.b = Math.imul(this.b ^ v, 0xc2b2ae35) ^ (this.b >>> 13);
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.add(s.charCodeAt(i));
    this.add(0x10000 | (s.length & 0xffff));
  }
  text(): string { return `${(this.a >>> 0).toString(16)}.${(this.b >>> 0).toString(16)}`; }

  value(v: unknown): void {
    if (v === undefined || typeof v === 'function') { this.add(0x20000); return; }
    if (v === null) { this.add(0x20001); return; }
    switch (typeof v) {
      case 'boolean': this.add(v ? 0x20003 : 0x20002); return;
      case 'number': case 'bigint': this.add(0x20004); this.str(String(v)); return;
      case 'string': this.add(0x20005); this.str(v); return;
    }
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      this.add(0x20006); this.str(v.constructor.name);
      for (let i = 0; i < bytes.length; i++) this.add(bytes[i]);
      this.add(0x30000 | (bytes.length & 0xffff)); this.add(bytes.length >>> 16);
      return;
    }
    if (Array.isArray(v)) {
      this.add(0x20007);
      for (const x of v) this.value(x);
      this.add(0x30000 | (v.length & 0xffff));
      return;
    }
    // Sets and Maps: their entries in the order of their hashes
    if (v instanceof Set) { this.add(0x20008); this.sorted([...v].map(inputHash)); return; }
    if (v instanceof Map) { this.add(0x20009); this.sorted([...v].map(inputHash)); return; }
    this.add(0x2000a);
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o).sort()) {
      if (o[k] === undefined || typeof o[k] === 'function') continue;
      this.str(k);
      this.value(o[k]);
    }
    this.add(0x2000b);
  }
  private sorted(hashes: string[]): void {
    for (const s of hashes.sort()) this.str(s);
    this.add(0x30000 | (hashes.length & 0xffff));
  }
}

// What a load of level n as edited is given (ov, the editor's App.buildOverrides: the level's data, its BG and
// layer 3 tilemaps, the view settings): the input of everything learned from the level as edited. Not what
// only records the load (byteOwner, trace, trackSources, fadeHook).
export function levelInput(n: number, ov: LevelOverride): { level: number; ov: LevelOverride } {
  return { level: n, ov: { ...ov, byteOwner: undefined, trace: undefined, trackSources: undefined, fadeHook: undefined } };
}

// The level as edited: a level and what its load is given (ov, App.buildOverrides), named by the hash of both (id; not
// of what only records the load, as levelInput). Learn jobs on it send it to the probe worker once (probeclient.ts).
export interface EditState { id: string; level: Level; ov: LevelOverride }
export function editState(level: Level, ov: LevelOverride): EditState {
  return { id: inputHash({ level, load: levelInput(level.number, ov) }), level, ov };
}
