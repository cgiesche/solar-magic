// ROM container: LoROM address mapping, header handling, expansion, checksum
// and RATS-tag based free space management. Besides the ROM image (`data`) it holds the editor's own
// data (`extra`: sources of patches, packages and tool projects) that the game never reads: kept
// outside the image, saved with a project file (outputProject) and left out of the playable ROM.

import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import type { RomReads } from './romdeps.ts';
export const MAX_ROM_SIZE = 0x400000;
// Offsets reachable only through banks $FE/$FF are reserved for the editor's
// emulation overlay, so we never allocate data there.
export const RESERVED_TOP = 0x3f0000;

export function snesToPc(addr: number): number {
  const bank = (addr >> 16) & 0x7f;
  return (bank << 15) | (addr & 0x7fff);
}
export function pcToSnes(off: number): number {
  const bank = off >> 15;
  let a = (bank << 16) | 0x8000 | (off & 0x7fff);
  if (bank >= 0x40) a |= 0x800000; // use FastROM mirror for banks beyond $3F
  return a;
}

// project file: ROM file, then a zip of the editor data, then this footer (magic, zip length, version)
const PROJECT_MAGIC = 'SMWEPROJ';
const FOOTER = 16;
const PROJECT_VERSION = 1;

export interface RomSnapshot { data: Uint8Array; extra: Map<string, Uint8Array> }

export interface RatsBlock {
  start: number; // offset of "STAR"
  size: number; // payload size
}

// a range of the ROM image by file offset (PC), end exclusive
export type RomRange = [start: number, end: number];

// changes the log keeps (older ones are forgotten: changesSince can't reach back further than that)
const LOG_MAX = 8192;
// equal bytes between two changed runs of one write that still make one range
const RUN_GAP = 16;

export class Rom {
  // counts changes of the ROM image: every write through these methods that changes a byte and every new
  // `data` (the editor data doesn't count). Emulators and caches compare it to see the ROM changed, and ask
  // changesSince what changed, so the image is only written through Rom – never into `data` directly.
  gen = 0;
  private image: Uint8Array;
  // the ranges each generation changed (in order), back to generation logFrom
  private log: { gen: number; start: number; end: number }[] = [];
  private logFrom = 0;
  get data(): Uint8Array { return this.image; }
  // a new image: the ranges differing from the old one (a size change counts as changed from the shorter size on)
  set data(d: Uint8Array) {
    const old = this.image;
    this.image = d;
    this.gen++;
    if (old === d) { this.record(0, d.length); return; }
    const n = Math.min(old.length, d.length);
    this.diff(old, 0, d, 0, n);
    if (old.length !== d.length) this.record(n, Math.max(old.length, d.length));
  }
  smcHeader: Uint8Array | null;
  reads: RomReads | null = null; // records reads through r8/r16/r24/bytes (see romdeps.ts)
  extra = new Map<string, Uint8Array>(); // editor data by id, not part of the ROM image (blobs are never changed in place)

  constructor(file: Uint8Array) {
    const hdr = file.length % 0x8000;
    this.smcHeader = hdr === 512 ? file.slice(0, 512) : null;
    this.image = file.slice(hdr);
  }

  // The ranges of the image changed since generation `since` (sorted, merged; may reach past the current size
  // when the image shrank); null when the log doesn't reach back that far.
  changesSince(since: number): RomRange[] | null {
    if (since < this.logFrom) return null;
    const out: RomRange[] = [];
    for (let i = this.log.length - 1; i >= 0 && this.log[i].gen > since; i--) out.push([this.log[i].start, this.log[i].end]);
    out.sort((a, b) => a[0] - b[0]);
    let k = 0;
    for (const r of out) {
      if (k && r[0] <= out[k - 1][1]) out[k - 1][1] = Math.max(out[k - 1][1], r[1]);
      else out[k++] = r;
    }
    out.length = k;
    return out;
  }

  private record(start: number, end: number): void {
    this.log.push({ gen: this.gen, start, end });
    if (this.log.length > LOG_MAX) {
      // (a generation partly dropped is the oldest one changesSince can't answer for)
      const drop = this.log.length >> 1;
      this.logFrom = this.log[drop - 1].gen;
      this.log = this.log.slice(drop);
    }
  }

  // records the runs where a[ao..] and b[bo..] differ (n bytes, as offsets from bo) as changed; whether any did
  private diff(a: Uint8Array, ao: number, b: Uint8Array, bo: number, n: number): boolean {
    let any = false;
    for (let i = 0; i < n; i++) {
      if (a[ao + i] === b[bo + i]) continue;
      let last = i;
      for (let j = i + 1; j < n && j - last <= RUN_GAP; j++) if (a[ao + j] !== b[bo + j]) last = j;
      this.record(bo + i, bo + last + 1);
      any = true;
      i = last;
    }
    return any;
  }

  // writes b at pc; a new generation only when a byte changes
  private put(pc: number, b: Uint8Array): void {
    const d = this.image;
    if (pc < 0 || pc + b.length > d.length) { d.set(b, pc); this.gen++; this.record(pc, pc + b.length); return; } // (throws)
    const gen = this.gen;
    this.gen++;
    if (!this.diff(b, 0, d, pc, b.length)) { this.gen = gen; return; }
    d.set(b, pc);
  }

  // a ROM file or a project file (ROM + editor data)
  static fromFile(file: Uint8Array): Rom {
    const split = splitProject(file);
    const rom = new Rom(split.rom);
    if (split.extra) rom.extra = split.extra;
    return rom;
  }

  // ---------- editor data ----------
  putBlob(data: Uint8Array): string {
    let id: string;
    do id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; while (this.extra.has(id));
    this.extra.set(id, data);
    return id;
  }
  getBlob(id: string): Uint8Array | null {
    return this.extra.get(id) ?? null;
  }
  dropBlob(id: string): void {
    this.extra.delete(id);
  }
  get extraSize(): number {
    let n = 0;
    for (const b of this.extra.values()) n += b.length;
    return n;
  }

  // the whole state (image and editor data), to go back to when a multi-step change fails
  snapshot(): RomSnapshot {
    return { data: this.data.slice(), extra: new Map(this.extra) };
  }
  restore(s: RomSnapshot): void {
    this.data = s.data;
    this.extra = new Map(s.extra);
  }

  get size(): number {
    return this.data.length;
  }

  r8(snes: number): number {
    const o = snesToPc(snes);
    this.reads?.read(o, 1);
    return this.data[o];
  }
  r16(snes: number): number {
    const o = snesToPc(snes);
    this.reads?.read(o, 2);
    return this.data[o] | (this.data[o + 1] << 8);
  }
  r24(snes: number): number {
    const o = snesToPc(snes);
    this.reads?.read(o, 3);
    return this.data[o] | (this.data[o + 1] << 8) | (this.data[o + 2] << 16);
  }
  w8(snes: number, v: number): void {
    this.put(snesToPc(snes), Uint8Array.of(v & 0xff));
  }
  w16(snes: number, v: number): void {
    this.put(snesToPc(snes), Uint8Array.of(v & 0xff, (v >> 8) & 0xff));
  }
  w24(snes: number, v: number): void {
    this.put(snesToPc(snes), Uint8Array.of(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff));
  }
  bytes(snes: number, len: number): Uint8Array {
    const o = snesToPc(snes);
    this.reads?.read(o, len);
    return this.data.slice(o, o + len);
  }
  writeBytes(snes: number, b: Uint8Array): void {
    this.writeAt(snesToPc(snes), b);
  }
  // by file offset (PC)
  writeAt(pc: number, b: Uint8Array): void {
    this.put(pc, b);
  }
  fillAt(pc: number, len: number, v = 0): void {
    this.put(pc, new Uint8Array(len).fill(v));
  }

  title(): string {
    return String.fromCharCode(...this.data.subarray(0x7fc0, 0x7fd5)).trim();
  }

  // ---------- expansion ----------
  expand(newSize: number): void {
    if (newSize <= this.data.length) return;
    if (newSize > MAX_ROM_SIZE) throw new Error('ROM size limit is 4 MB');
    const d = new Uint8Array(newSize);
    d.set(this.data);
    this.data = d;
    // header ROM size byte: 2^n KB
    let n = 0;
    while ((1 << n) * 1024 < newSize) n++;
    this.writeAt(0x7fd7, Uint8Array.of(n));
  }

  fixChecksum(): void {
    const d = this.data;
    // SNES checksum: sum of all bytes (the checksum and its complement counted as $FFFF, $0000); non power-of-two
    // sizes mirror the upper part
    let pow = 1;
    while (pow * 2 <= d.length) pow *= 2;
    let sum = 0;
    for (let i = 0; i < pow; i++) sum += d[i];
    sum += 0xff + 0xff - d[0x7fdc] - d[0x7fdd] - d[0x7fde] - d[0x7fdf];
    if (pow < d.length) {
      const rest = d.length - pow;
      let part = 0;
      for (let i = pow; i < d.length; i++) part += d[i];
      sum += part * (pow / rest);
    }
    sum &= 0xffff;
    this.writeAt(0x7fdc, Uint8Array.of(~sum & 0xff, (~sum >> 8) & 0xff, sum & 0xff, sum >> 8));
  }

  // the playable ROM (without the editor data)
  output(withHeader: boolean): Uint8Array {
    this.fixChecksum();
    if (!withHeader) return this.data.slice();
    const out = new Uint8Array(this.data.length + 512);
    if (this.smcHeader) out.set(this.smcHeader);
    out.set(this.data, 512);
    return out;
  }

  // the ROM with the editor data appended (a project file, see Rom.fromFile)
  outputProject(withHeader: boolean): Uint8Array {
    const rom = this.output(withHeader);
    if (!this.extra.size) return rom;
    const z = packExtra(this.extra);
    const out = new Uint8Array(rom.length + z.length + FOOTER);
    out.set(rom);
    out.set(z, rom.length);
    const f = rom.length + z.length;
    for (let i = 0; i < 8; i++) out[f + i] = PROJECT_MAGIC.charCodeAt(i);
    new DataView(out.buffer).setUint32(f + 8, z.length, true);
    out[f + 12] = PROJECT_VERSION;
    return out;
  }

  // ---------- RATS ----------
  isRatsAt(off: number): number {
    const d = this.data;
    if (d[off] !== 0x53 || d[off + 1] !== 0x54 || d[off + 2] !== 0x41 || d[off + 3] !== 0x52) return -1;
    const s = d[off + 4] | (d[off + 5] << 8);
    const inv = d[off + 6] | (d[off + 7] << 8);
    if ((s ^ inv) !== 0xffff) return -1;
    return s + 1;
  }

  scanRats(): RatsBlock[] {
    const out: RatsBlock[] = [];
    const d = this.data;
    for (let i = 0x80000; i < d.length - 8; i++) {
      if (d[i] !== 0x53) continue;
      const size = this.isRatsAt(i);
      if (size > 0) {
        out.push({ start: i, size });
        i += 7 + size;
      }
    }
    return out;
  }

  // Find free space of `len` bytes (+8 for RATS) not crossing a bank boundary,
  // in expanded area (>= 0x80000). Free = not covered by a RATS block and all bytes
  // are 0x00 (like Asar's free space search, so untagged patch data is never overwritten).
  findFree(len: number, used?: RatsBlock[]): number {
    const total = len + 8;
    if (total > 0x8000) throw new Error('block larger than one bank');
    const blocks = used ?? this.scanRats();
    const d = this.data;
    const occupied = new Uint8Array(Math.ceil(d.length / 16));
    for (const b of blocks) {
      for (let o = b.start; o < b.start + 8 + b.size; o += 16) occupied[o >> 4] = 1;
      occupied[(b.start + 8 + b.size - 1) >> 4] = 1;
    }
    const used16 = (o: number) => {
      if (occupied[o >> 4]) return true;
      for (let i = o; i < o + 16; i++) if (d[i] !== 0) return true;
      return false;
    };
    const limit = Math.min(d.length, RESERVED_TOP);
    for (let bank = 0x10; bank * 0x8000 < limit; bank++) {
      let run = 0;
      let runStart = bank * 0x8000;
      for (let o = bank * 0x8000; o < (bank + 1) * 0x8000 && o < limit; o += 16) {
        if (used16(o)) { run = 0; runStart = o + 16; continue; }
        run += 16;
        if (run >= total + 16) return runStart;
      }
    }
    return -1;
  }

  // The free space a block of `len` bytes takes with its RATS tag: findFree works in 16-byte steps, so the
  // next block starts at the next 16-byte boundary.
  static ratsFootprint(len: number): number {
    return Math.ceil((len + 8) / 16) * 16;
  }

  // Write data with RATS tag in free space; returns SNES address of payload.
  // Expands the ROM if necessary.
  allocWrite(payload: Uint8Array): number {
    let off = this.findFree(payload.length);
    while (off < 0) {
      if (this.data.length >= MAX_ROM_SIZE) throw new Error('ROM is full');
      this.expand(Math.min(MAX_ROM_SIZE, Math.max(0x100000, this.data.length * 2)));
      off = this.findFree(payload.length);
    }
    const s = payload.length - 1;
    this.writeAt(off, Uint8Array.from([0x53, 0x54, 0x41, 0x52, s & 0xff, s >> 8, ~s & 0xff, (~s >> 8) & 0xff]));
    this.writeAt(off + 8, payload);
    return pcToSnes(off + 8);
  }

  // Free a RATS-protected block whose payload starts at SNES address `addr`.
  // Returns true if it was a RATS block.
  freeAt(addr: number): boolean {
    const off = snesToPc(addr) - 8;
    if (off < 0x80000) return false;
    const size = this.isRatsAt(off);
    if (size < 0) return false;
    this.fillAt(off, 8 + size);
    return true;
  }
}

// editor data as a zip: one file per blob, named by its id
export function packExtra(extra: Map<string, Uint8Array>): Uint8Array {
  const files: Zippable = { 'manifest.json': strToU8(JSON.stringify({ v: PROJECT_VERSION, ids: [...extra.keys()] })) };
  for (const [id, b] of extra) files['blob/' + id] = [b, { level: 0 }]; // blobs are zips already
  return zipSync(files);
}
export function unpackExtra(z: Uint8Array): Map<string, Uint8Array> {
  const files = unzipSync(z);
  const meta = JSON.parse(strFromU8(files['manifest.json'])) as { v: number; ids: string[] };
  if (meta.v > PROJECT_VERSION) throw new Error('The project file is from a newer editor version');
  return new Map(meta.ids.filter((id) => files['blob/' + id]).map((id) => [id, files['blob/' + id]]));
}

// a file's ROM part and editor data (null for a plain ROM)
export function splitProject(file: Uint8Array): { rom: Uint8Array; extra: Map<string, Uint8Array> | null } {
  if (file.length > FOOTER) {
    const f = file.length - FOOTER;
    let magic = true;
    for (let i = 0; i < 8; i++) if (file[f + i] !== PROJECT_MAGIC.charCodeAt(i)) magic = false;
    if (magic) {
      const n = new DataView(file.buffer, file.byteOffset).getUint32(f + 8, true);
      if (n <= f) return { rom: file.subarray(0, f - n), extra: unpackExtra(file.subarray(f - n, f)) };
    }
  }
  return { rom: file, extra: null };
}
