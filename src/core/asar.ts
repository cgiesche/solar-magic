// Asar (65816 assembler, https://github.com/RPGHacker/asar, LGPL-3.0) compiled to WebAssembly
// (tools/build-asar.sh). Patches are assembled against a copy of the ROM with all their files
// held in memory; nothing touches a real file system.

import type { AsarModule } from '../vendor/asar/asar.mjs';
import { MAX_ROM_SIZE } from './rom.ts';

export interface AsarMessage { message: string; full: string; file: string; line: number }
export interface AsarResult {
  ok: boolean;
  rom: Uint8Array; // patched ROM (unchanged copy when !ok)
  errors: AsarMessage[];
  warnings: AsarMessage[];
  prints: string[];
  labels: Record<string, number>;
  blocks: { pc: number; snes: number; size: number }[]; // everything Asar wrote
}

let mod: AsarModule | null = null;
let loading: Promise<AsarModule> | null = null;

export function asarReady(): boolean {
  return mod !== null;
}
export function loadAsar(): Promise<AsarModule> {
  if (mod) return Promise.resolve(mod);
  loading ??= import('../vendor/asar/asar.mjs').then((a) => a.default()).then((m) => (mod = m));
  return loading;
}
export function asarVersion(): number {
  if (!mod) throw new Error('Asar is not loaded yet');
  return mod._smwe_version();
}

// files: path (relative, "/" separated) → contents; main: path of the patch to assemble.
export function assemble(rom: Uint8Array, files: Map<string, Uint8Array | string>, main: string, defines: Record<string, string> = {}): AsarResult {
  const m = mod;
  if (!m) throw new Error('Asar is not loaded yet');
  if (rom.length > MAX_ROM_SIZE) throw new Error('ROM is larger than 4 MB');
  const allocs: number[] = [];
  const alloc = (n: number) => { const p = m._malloc(Math.max(n, 1)); allocs.push(p); return p; };
  const str = (s: string) => { const p = m.stringToNewUTF8(s); allocs.push(p); return p; };
  const ptrs = (vals: number[]) => { const p = alloc(vals.length * 4); for (let i = 0; i < vals.length; i++) m.HEAP32[(p >> 2) + i] = vals[i]; return p; };
  const abs = (p: string) => '/' + p.replace(/^\/+/, '');
  try {
    const romPtr = alloc(MAX_ROM_SIZE);
    m.HEAPU8.fill(0, romPtr, romPtr + MAX_ROM_SIZE);
    m.HEAPU8.set(rom, romPtr);
    const lenPtr = ptrs([rom.length]);
    const enc = new TextEncoder();
    const names: number[] = [], bufs: number[] = [], lens: number[] = [];
    for (const [path, content] of files) {
      const data = typeof content === 'string' ? enc.encode(content) : content;
      const p = alloc(data.length);
      m.HEAPU8.set(data, p);
      names.push(str(abs(path))); bufs.push(p); lens.push(data.length);
    }
    const defs = Object.entries(defines);
    const out = m._smwe_patch(
      str(abs(main)), romPtr, MAX_ROM_SIZE, lenPtr,
      ptrs(names), ptrs(bufs), ptrs(lens), names.length,
      ptrs(defs.map(([k]) => str(k))), ptrs(defs.map(([, v]) => str(v))), defs.length,
    );
    const r = JSON.parse(m.UTF8ToString(out)) as {
      ok: boolean; romlen: number; errors: AsarMessage[]; warnings: AsarMessage[]; prints: string[];
      labels: Record<string, number>; blocks: [number, number, number][];
    };
    const romlen = r.ok ? r.romlen : rom.length;
    return {
      ok: r.ok,
      rom: r.ok ? m.HEAPU8.slice(romPtr, romPtr + romlen) : rom.slice(),
      errors: r.errors, warnings: r.warnings, prints: r.prints, labels: r.labels,
      blocks: r.blocks.map(([pc, snes, size]) => ({ pc, snes, size })),
    };
  } finally {
    for (const p of allocs) m._free(p);
  }
}
