// Names of GFX/ExGFX files ("SMWN"): what the user calls a file in the Graphics tab, or the name taken
// from an imported file's descriptive name (ExGFX80_Forest.bin). Without one a file is named after the
// package that brought it. Kept in the ROM like the package registry: a RATS block holding "SMWN", a
// version byte and deflated JSON (number in hex → name). The game never reads it.

import { deflateSync, inflateSync } from 'fflate';
import { Rom, pcToSnes } from './rom.ts';
import { listPackages } from './pkgreg.ts';

const MAGIC = [0x53, 0x4d, 0x57, 0x4e]; // "SMWN"
const VERSION = 1;
export const GFX_NAME_MAX = 64;

function find(rom: Rom): number {
  for (const b of rom.scanRats()) {
    const p = b.start + 8;
    if (b.size > 5 && MAGIC.every((m, i) => rom.data[p + i] === m)) return p;
  }
  return -1;
}

export function gfxNames(rom: Rom): Map<number, string> {
  const p = find(rom);
  if (p < 0) return new Map();
  if (rom.data[p + 4] > VERSION) throw new Error('GFX names in the ROM are from a newer editor version');
  const size = rom.isRatsAt(p - 8);
  const all = JSON.parse(new TextDecoder().decode(inflateSync(rom.data.subarray(p + 5, p + size)))) as Record<string, string>;
  return new Map(Object.entries(all).map(([k, v]) => [parseInt(k, 16), v]));
}

// sets names (an empty one or null removes it), written once
export function setGfxNames(rom: Rom, names: Map<number, string | null>): void {
  const all = gfxNames(rom);
  for (const [n, name] of names) {
    const v = name?.trim().slice(0, GFX_NAME_MAX) ?? '';
    if (v) all.set(n, v); else all.delete(n);
  }
  const old = find(rom);
  if (old >= 0) rom.freeAt(pcToSnes(old));
  if (!all.size) return;
  const json = JSON.stringify(Object.fromEntries([...all].sort((a, b) => a[0] - b[0]).map(([n, v]) => [n.toString(16), v])));
  const z = deflateSync(new TextEncoder().encode(json), { level: 9 });
  const buf = new Uint8Array(z.length + 5);
  buf.set(MAGIC); buf[4] = VERSION; buf.set(z, 5);
  rom.allocWrite(buf);
}

export function setGfxName(rom: Rom, num: number, name: string | null): void {
  setGfxNames(rom, new Map([[num, name]]));
}

// the user's name of a file, null: none
export function gfxUserName(rom: Rom, num: number): string | null {
  return gfxNames(rom).get(num) ?? null;
}

// what a file is called: the user's name, else the package's that brought it; null: nothing known
export function gfxLabel(rom: Rom, num: number): string | null {
  return gfxLabels(rom)(num);
}

// gfxLabel for many files: the names and packages read once
export function gfxLabels(rom: Rom): (num: number) => string | null {
  const names = gfxNames(rom), pkgs = listPackages(rom);
  return (num) => names.get(num) ?? pkgs.find((p) => p.gfx.includes(num))?.name ?? null;
}
