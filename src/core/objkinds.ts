// What the nibbles of a standard object's settings byte mean, found out by emulating the object
// routines of the loaded ROM (no built-in object tables):
// - a nibble whose growing values make the object grow is a size (width or height),
// - a nibble that changes the tiles but not steadily the extent is a type (sub-object, e.g. 13: ledge
//   edges/vines/dirt). A type is valid up to the first value whose routine reads data beyond its
//   table: bytes that are executed as code, or that another instruction reads for a lower type.
//   Types that only repeat an earlier one end the list too.
// Where the ROM reads object 2D with an extension (obj2d.ts), each of its custom numbers that draws is probed the
// same way, the nibbles of its 5th byte (the custom object's settings, $58) and of its 3rd: the kind names the
// byte that sizes it (#149).

import type { LevelEmulator, ObjectTrace } from './levelemu.ts';
import { OV_L1, MAP_BASE, readOffset } from './levelemu.ts';
import { layerGeom } from './render.ts';
import { encodePrimaryHeader, serializeObjects, newUid, type LevelObject, type Level } from './level.ts';
import { RomReads } from './romdeps.ts';
import { objectLength2D, fitExtension, OBJ_2D } from './obj2d.ts';

export interface ObjKind {
  type: 'lo' | 'hi' | null; // nibble that selects a sub-object
  count: number; // number of valid types
  lo: 'w' | 'h' | null; // what the low nibble sizes (null: type or ignored)
  hi: 'w' | 'h' | null;
  // the byte the nibbles are of: the settings byte (the object's 3rd), or 'ext' for a custom number of object 2D
  // its 5th (its extension's second)
  byte?: 'ext';
}

// kind used when nothing is known: low nibble = width, high nibble = height
const PLAIN: ObjKind = { type: null, count: 0, lo: 'w', hi: 'h' };
// a custom number neither of whose bytes sizes it (or that draws nothing)
export const UNSIZED: ObjKind = { type: null, count: 0, lo: null, hi: null };

export interface ObjKinds {
  kinds: Map<number, ObjKind>; // standard objects 01–3F, those not plain
  custom: Map<number, ObjKind>; // object 2D's custom numbers that draw (where the ROM reads its extension)
}

// the result cache key of a tileset's object kinds
export const kindsKey = (ts: number) => `ok2:${ts}`;

// the byte an object's kind names (its nibbles size it or select its type), and an object with it set to v
export function sizedByte(kind: ObjKind | null | undefined, o: { size: number; extension?: number[] }): number {
  return kind?.byte === 'ext' ? o.extension?.[1] ?? 0 : o.size;
}
export function withSizedByte<T extends { size: number; extension?: number[] }>(kind: ObjKind | null | undefined, o: T, v: number): T {
  const c = { ...o, ...o.extension ? { extension: [...o.extension] } : {} };
  setSizedByte(kind, c, v);
  return c;
}
// (o itself; a 5th byte only where the object has one)
export function setSizedByte(kind: ObjKind | null | undefined, o: { size: number; extension?: number[] }, v: number): void {
  if (kind?.byte !== 'ext') o.size = v;
  else if (o.extension && o.extension.length > 1) o.extension[1] = v;
}

interface Shape { w: number; h: number; sig: string }
interface Run { shape: Shape | null; reads: Set<number> }

// objects per emulated level load: each starts a screen with an empty screen to its left (routines may
// grow to the left, some misbehave when they start just before a screen edge); the last must still fit
// the level when it grows (see growth)
const PER = 13;

function shapeOf(writes: Map<number, number> | undefined, pos: (off: number) => [number, number] | undefined): Shape | null {
  if (!writes?.size) return null;
  const t: [number, number, number][] = [];
  for (const [off, v] of writes) { const p = pos(off); if (p) t.push([p[0], p[1], v]); }
  if (!t.length) return null;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (const [x, y] of t) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1, sig: t.map(([x, y, v]) => `${x - x0},${y - y0},${v}`).sort().join(' ') };
}

// the level whose header (tileset, …) the objects are loaded with
export type KindLevel = Pick<Level, 'number' | 'header'>;

interface Spec { num: number; size: number; extension?: number[] }

// the 16 values of each nibble of a byte, the other nibble 2
const nibbleValues = (): number[] => [...Array.from({ length: 16 }, (_, v) => 0x20 | v), ...Array.from({ length: 16 }, (_, v) => (v << 4) | 2)];
// the settings (5th byte) of a custom number tried first: whether it draws
const FIRST = [[0x00, 0x00], [0x22, 0x22]]; // (3rd byte, 5th byte)
const OTHER = 0x22; // the byte not probed, while the other's nibbles are

// Objects 01-3F, each with the low nibble 0-F (high = 2) and the high nibble 0-F (low = 2). Where object 2D has an
// extension: each custom number at FIRST, then those that drew at either the same for its 5th byte and its 3rd.
// Runs in steps (one emulated level load each) so a UI can spread it over idle time.
export class ObjKindProbe {
  private specs: Spec[] = [];
  private customs: number[] = []; // the custom numbers probed for their nibbles, in this order after the first ones
  private firstAt = -1; // where the custom numbers' first specs start (-1: none)
  private nibblesAt = -1; // where their nibbles' start (-1: not yet added)
  private len2d: number;
  private runs: Run[] = [];
  private code = new Set<number>();
  private romRead = new Set<number>();
  private pos: (off: number) => [number, number] | undefined;
  private todo: [number, number][] = []; // spec ranges still to load, in order
  private emu: LevelEmulator;
  private level: KindLevel;
  private layer2Pointer: number;

  constructor(emu: LevelEmulator, level: KindLevel, layer2Pointer: number) {
    this.emu = emu;
    this.level = level;
    this.layer2Pointer = layer2Pointer;
    const g = layerGeom(emu.rom, 0, 0, 32);
    const inv = new Map<number, [number, number]>();
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) inv.set(g.addr(x, y) - MAP_BASE, [x, y]);
    this.pos = (off) => inv.get(off);
    for (let n = 1; n < 0x40; n++) for (const size of nibbleValues()) this.specs.push({ num: n, size });
    this.len2d = objectLength2D(emu.rom);
    if (this.len2d > 3) {
      this.firstAt = this.specs.length;
      for (let c = 0; c < 0x100; c++) for (const [size, set] of FIRST) this.specs.push({ num: OBJ_2D, size, extension: this.extension(c, set) });
    }
    this.queue(0);
  }

  // object 2D's extension for custom number c with the settings set (its 5th byte, where it has one)
  private extension(c: number, set: number): number[] {
    return Array.from({ length: this.len2d - 3 }, (_, i) => (i === 0 ? c : i === 1 ? set : 0));
  }

  private queue(from: number): void {
    for (let i = from; i < this.specs.length; i += PER) this.todo.push([i, Math.min(i + PER, this.specs.length)]);
  }

  get done(): boolean { return !this.todo.length && (this.firstAt < 0 || this.nibblesAt >= 0); }

  // one emulated level load; a crashing object (invalid type) spoils its whole batch, so a failed
  // batch is split up and its halves are loaded in the next steps (a failed load takes long: splitting
  // all at once would stall a UI for a second or more)
  step(): void {
    if (!this.todo.length && this.firstAt >= 0 && this.nibblesAt < 0) this.addNibbles();
    const [a, b] = this.todo.shift() ?? [];
    if (a === undefined || b === undefined) return;
    const runs = this.run(this.specs.slice(a, b));
    if (runs) runs.forEach((r, i) => (this.runs[a + i] = r));
    else { const h = a + ((b - a) >> 1); this.todo.unshift([a, h], [h, b]); }
  }

  // the custom numbers that drew at either of FIRST get their nibbles probed: those of the 5th byte (where object
  // 2D has one), then those of the 3rd, the other byte OTHER
  private addNibbles(): void {
    this.nibblesAt = this.specs.length;
    for (let c = 0; c < 0x100; c++) {
      if (!FIRST.some((_, j) => this.runs[this.firstAt + c * FIRST.length + j]?.shape)) continue;
      this.customs.push(c);
      for (const v of nibbleValues()) this.specs.push({ num: OBJ_2D, size: OTHER, extension: this.extension(c, v) });
      for (const v of nibbleValues()) this.specs.push({ num: OBJ_2D, size: v, extension: this.extension(c, OTHER) });
    }
    this.queue(this.nibblesAt);
  }

  // null: the load failed and the batch has to be split
  private run(batch: Spec[]): Run[] | null {
    const objs: LevelObject[] = batch.map((s, i) => ({ uid: newUid(), num: s.num, ext: 0, size: s.size, x: i * 32 + 16, y: 4, ...(s.extension ? { extension: s.extension } : {}) }));
    for (const o of objs) fitExtension(o, this.len2d); // (2D among the standard objects as the ROM reads it: custom number 00)
    const owners: number[] = [-1, -1, -1, -1, -1];
    const body = serializeObjects(objs, [], false, owners);
    const l1 = new Uint8Array(5 + body.length);
    l1.set(encodePrimaryHeader({ ...this.level.header, screens: 32, mode: 0 }));
    l1.set(body, 5);
    const byteOwner = new Int32Array(0x10000).fill(-1);
    owners.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    const r = this.emu.load(this.level.number, { layer1: l1, layer2Pointer: this.layer2Pointer, sprites: new Uint8Array([0, 0xff]), byteOwner, trace: true });
    if (!r.ok && batch.length > 1) return null;
    const tr = r.trace as ObjectTrace;
    for (const c of tr.code) this.code.add(c);
    for (const c of tr.rom) this.romRead.add(c);
    return batch.map((_, i) => ({ shape: r.ok ? shapeOf(tr.writes.get(i), this.pos) : null, reads: tr.reads.get(i) ?? new Set() }));
  }

  result(): ObjKinds {
    while (!this.done) this.step();
    const kinds = new Map<number, ObjKind>();
    for (let n = 1; n < 0x40; n++) {
      const k = (n - 1) * 32;
      const kind = classify(this.runs.slice(k, k + 16), this.runs.slice(k + 16, k + 32), this.code);
      if (kind) kinds.set(n, kind);
    }
    const custom = new Map<number, ObjKind>();
    const sizes = (k: ObjKind) => !!(k.lo || k.hi || k.type);
    this.customs.forEach((c, i) => {
      const k = this.nibblesAt + i * 64, at = (j: number) => this.runs.slice(k + j * 16, k + j * 16 + 16);
      const ext = this.len2d >= 5 ? classify(at(0), at(1), this.code) ?? PLAIN : UNSIZED;
      const set = classify(at(2), at(3), this.code) ?? PLAIN;
      custom.set(c, sizes(ext) ? { ...ext, byte: 'ext' } : sizes(set) ? set : UNSIZED);
    });
    return { kinds, custom };
  }

  // what the result depends on: the single ROM bytes the object routines read (not the level load
  // around them, so saving a level doesn't drop it)
  reads(): RomReads {
    const r = new RomReads(this.emu.rom);
    for (const o of this.romRead) r.bytes.add(o);
    return r;
  }
}

const area = (s: Shape | null) => (s ? s.w * s.h : 0);

// a size nibble makes the object bigger with every step (or keeps the very same tiles once it hits a limit);
// checked for 1-5: value 0 is often treated as 256, large values can run into the level's edges
function growth(runs: Run[]): 'w' | 'h' | 'wh' | null {
  let gw = false, gh = false;
  for (let v = 1; v < 5; v++) {
    const a = runs[v].shape, b = runs[v + 1].shape;
    if (!a || !b) return null;
    if (area(b) > area(a)) { gw ||= b.w > a.w; gh ||= b.h > a.h; continue; }
    if (area(b) === area(a) && a.sig === b.sig) continue;
    return null;
  }
  return gw && gh ? 'wh' : gw ? 'w' : gh ? 'h' : null;
}

function changes(runs: Run[]): boolean {
  return runs.some((r) => r.shape?.sig !== runs[1].shape?.sig);
}

// number of valid types: stops at the first value that draws nothing, repeats an earlier type, or
// reads beyond its table. Only reads that are new for the instruction count (constant reads, like
// jump table entries, do not): into code, or into bytes another instruction read for a lower type.
function typeCount(runs: Run[], code: Set<number>): number {
  const pairs = new Set<number>(); // pc * 2^23 + ROM offset, read for lower types
  const readers = new Set<number>(); // ROM offsets read for lower types
  const sigs = new Set<string>();
  for (let t = 0; t < 16; t++) {
    const r = runs[t];
    if (!r.shape || sigs.has(r.shape.sig)) return t;
    for (const key of r.reads) {
      if (pairs.has(key)) continue;
      const ro = readOffset(key);
      if (code.has(ro) || readers.has(ro)) return t;
    }
    for (const key of r.reads) { pairs.add(key); readers.add(readOffset(key)); }
    sigs.add(r.shape.sig);
  }
  return 16;
}

function classify(lo: Run[], hi: Run[], code: Set<number>): ObjKind | null {
  const gl = growth(lo), gh = growth(hi);
  const dim = (g: 'w' | 'h' | 'wh' | null, def: 'w' | 'h') => (g === 'wh' ? def : g);
  if (gl && gh) {
    const l = dim(gl, 'w'), h = dim(gh, 'h');
    return l === 'w' && h === 'h' ? null : { type: null, count: 0, lo: l, hi: h };
  }
  const nib: 'lo' | 'hi' | null = !gl && changes(lo) ? 'lo' : !gh && changes(hi) ? 'hi' : null;
  if (!nib) return gl || gh ? { type: null, count: 0, lo: dim(gl, 'w'), hi: dim(gh, 'h') } : { type: null, count: 0, lo: null, hi: null };
  const count = typeCount(nib === 'lo' ? lo : hi, code);
  if (count < 2) return { type: null, count: 0, lo: nib === 'lo' ? null : dim(gl, 'w'), hi: nib === 'hi' ? null : dim(gh, 'h') };
  return nib === 'lo' ? { type: 'lo', count, lo: null, hi: dim(gh, 'h') } : { type: 'hi', count, lo: dim(gl, 'w'), hi: null };
}

// ---- settings byte helpers ----

// type of a sub-object, -1 for objects without types
export function objectVariant(kind: ObjKind | null | undefined, size: number): number {
  return !kind?.type ? -1 : kind.type === 'lo' ? size & 15 : size >> 4;
}

export function withObjectVariant(kind: ObjKind | null | undefined, size: number, t: number): number {
  if (!kind?.type) return size;
  return kind.type === 'lo' ? (size & 0xf0) | (t & 15) : ((t & 15) << 4) | (size & 15);
}

// settings byte of an object resized by dw/dh tiles; type nibbles and ignored nibbles stay untouched
export function resizeObjectSize(kind: ObjKind | null | undefined, size: number, dw: number, dh: number): number {
  const k = kind ?? PLAIN;
  if (k.lo === 'w' && k.hi === 'w') return Math.max(0, Math.min(255, size + dw)); // whole byte is the width
  const step = (d: 'w' | 'h' | null, v: number) => (d ? Math.max(0, Math.min(15, v + (d === 'w' ? dw : dh))) : v);
  return (step(k.hi, size >> 4) << 4) | step(k.lo, size & 15);
}

// ObjKindProbe as a job (jobrunner.ts, without the boot's reads): a step per emulated level load; what it reads is
// what the probe's reads() gives, not the level loads around the object routines
export function* objKindsJob(emu: LevelEmulator, level: KindLevel, layer2Pointer: number): Generator<void, ObjKinds> {
  const untracked = <T>(fn: () => T) => emu.tracked(fn, null, false).result;
  const probe = untracked(() => new ObjKindProbe(emu, level, layer2Pointer));
  while (!probe.done) {
    untracked(() => probe.step());
    emu.count(probe.reads());
    yield;
  }
  return probe.result();
}
