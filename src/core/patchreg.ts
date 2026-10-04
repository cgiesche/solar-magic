// Registry of applied ASM patches ("SMWA"), kept in the ROM so a patch can be removed again
// even without its sources: a RATS block holding "SMWA", a version byte and JSON. For each patch it
// lists the bytes it changed outside its own free space (with the original bytes, stored in
// separate RATS blocks) and the free space blocks it created, and the free RAM it uses: claimed
// ranges (`ram`) and the RAM its code writes with long addressing (`ramSeen`, found in its code).

import { Rom, pcToSnes, snesToPc } from './rom.ts';

const MAGIC = [0x53, 0x4d, 0x57, 0x41]; // "SMWA"
const VERSION = 1;
const CHUNK = 0x7f00; // backup bytes per RATS block

export interface PatchEntry {
  id: string;
  name: string;
  version?: string;
  hash: string; // of the sources and defines, to tell whether a patch is up to date
  defines: Record<string, string>;
  applied: string; // ISO date
  segs: [number, number][]; // [pc, size] changed outside own free space, in order
  backup: number[]; // SNES addresses of the RATS blocks holding the original bytes of segs
  own: number[]; // pc of the RATS tags of the patch's free space blocks
  check: number; // hash of the patched bytes of segs, to notice later edits
  kind?: 'patch' | 'uberasm' | 'blocks' | 'vram' | 'pixi';
  src?: number[]; // SNES addresses of RATS blocks holding the sources (zip), if stored in the ROM
  srcSize?: number;
  ram?: RamClaim[]; // free RAM the patch claims
  ramSeen?: [number, number][]; // [snes, size] written with long addressing by its code
}

// [snes, size, shared]: WRAM ($7E0000-$7FFFFF); shared = 1: an interface other code may write (e.g.
// PIXI's sprite tables, set by blocks spawning sprites)
export type RamClaim = [number, number, number?];

interface Registry { v: number; patches: PatchEntry[] }

function findRegistry(rom: Rom): number {
  for (const b of rom.scanRats()) {
    const p = b.start + 8;
    if (b.size > 5 && MAGIC.every((m, i) => rom.data[p + i] === m)) return p;
  }
  return -1;
}

function read(rom: Rom): Registry {
  const p = findRegistry(rom);
  if (p < 0) return { v: VERSION, patches: [] };
  const size = rom.isRatsAt(p - 8);
  if (rom.data[p + 4] > VERSION) throw new Error('Patch-Verzeichnis im ROM stammt von einer neueren Editor-Version');
  return JSON.parse(new TextDecoder().decode(rom.data.subarray(p + 5, p - 8 + 8 + size))) as Registry;
}

function write(rom: Rom, reg: Registry): void {
  const old = findRegistry(rom);
  if (old >= 0) rom.freeAt(pcToSnes(old));
  if (!reg.patches.length) return;
  const json = new TextEncoder().encode(JSON.stringify(reg));
  if (json.length + 5 > CHUNK) throw new Error('Patch-Verzeichnis ist zu groß');
  const buf = new Uint8Array(json.length + 5);
  buf.set(MAGIC); buf[4] = VERSION; buf.set(json, 5);
  rom.allocWrite(buf);
}

export function listPatches(rom: Rom): PatchEntry[] {
  return read(rom).patches;
}

export function hashBytes(parts: Iterable<Uint8Array>): number {
  let h = 0x811c9dc5;
  for (const b of parts) for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return h >>> 0;
}

export function patchedHash(rom: Rom, segs: [number, number][]): number {
  return hashBytes(segs.map(([pc, n]) => rom.data.subarray(pc, pc + n)));
}

export function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[0] + b[1] && b[0] < a[0] + a[1];
}

// the registered patch that changed any byte of [pc, pc+len), with the part that is its own code
export function ownerOf(rom: Rom, pc: number, len = 1): PatchEntry | null {
  for (const p of read(rom).patches) {
    if (p.segs.some((s) => overlaps(s, [pc, len]))) return p;
    if (p.own.some((o) => { const n = rom.isRatsAt(o); return n > 0 && overlaps([o, n + 8], [pc, len]); })) return p;
  }
  return null;
}

// " (belegt durch Patch „X“)" for error messages of the built-in patches, '' if no patch is there
export function ownerNote(rom: Rom, snes: number, len: number): string {
  const p = ownerOf(rom, snesToPc(snes), len);
  return p ? ` (belegt durch Patch „${p.name}“)` : '';
}

export function writeChunks(rom: Rom, data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += CHUNK) out.push(rom.allocWrite(data.subarray(i, i + CHUNK)));
  return out;
}
export function readChunks(rom: Rom, addrs: number[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const addr of addrs) {
    const n = Math.min(CHUNK, total - o);
    out.set(rom.bytes(addr, n), o);
    o += n;
  }
  return out;
}

// adds an entry; original[i] holds the bytes of segs[i] before the patch; archive: sources to keep in the ROM
export function addPatch(rom: Rom, entry: Omit<PatchEntry, 'backup' | 'src' | 'srcSize'>, original: Uint8Array[], archive?: Uint8Array): PatchEntry {
  const reg = read(rom);
  const all = new Uint8Array(original.reduce((n, o) => n + o.length, 0));
  let o = 0;
  for (const b of original) { all.set(b, o); o += b.length; }
  const full: PatchEntry = { ...entry, backup: writeChunks(rom, all) };
  if (archive) { full.src = writeChunks(rom, archive); full.srcSize = archive.length; }
  reg.patches.push(full);
  write(rom, reg);
  return full;
}

export function backupBytes(rom: Rom, p: PatchEntry): Uint8Array {
  return readChunks(rom, p.backup, p.segs.reduce((n, s) => n + s[1], 0));
}

// the sources stored with the patch, null if they were not kept in the ROM
export function patchArchive(rom: Rom, p: PatchEntry): Uint8Array | null {
  return p.src && p.srcSize ? readChunks(rom, p.src, p.srcSize) : null;
}

export function removeEntry(rom: Rom, id: string): void {
  const reg = read(rom);
  const p = reg.patches.find((e) => e.id === id);
  if (!p) return;
  for (const addr of [...p.backup, ...(p.src ?? [])]) rom.freeAt(addr);
  reg.patches = reg.patches.filter((e) => e.id !== id);
  write(rom, reg);
}
