// AN2 per level ("SMWN"), as the editor patched it for a while (like Lunar Magic's AN2 slot): a hook at
// $00A5BF (the level load's JSL $05BE8A) copied a level's uncompressed 4bpp ExGFX file to $7EAD00, where
// ExAnimation slots took RAM frames from. Animation frames come from the Anim graphics now (ADR 0003):
// opening a ROM with the patch copies the frames its levels' slots use into the level list's Anim
// graphic (exanim.ts localizeFrames), points the slots there and takes the patch out.

import type { Rom } from './rom.ts';
import { gfxEntry } from './patches.ts';
import { readLevelList, writeLevelList, localizeFrames, kindOf, AN2_FRAMES, AN2_FRAMES_END, type ExSlot } from './exanim.ts';
import { LevelEmulator } from './levelemu.ts';

const HOOK = 0x00a5bf;
const MAGIC = [0x53, 0x4d, 0x57, 0x4e]; // "SMWN"
const ORIG = [0x22, 0x8a, 0xbe, 0x05]; // JSL $05BE8A

// the patch's block (magic, table pointer, code) and its table of 512 files ($FF = none)
function an2Patch(rom: Rom): { base: number; table: number } | null {
  if (rom.r8(HOOK) !== 0x22) return null;
  const base = rom.r24(HOOK + 1) - 8;
  if (!MAGIC.every((m, i) => rom.r8(base + i) === m)) return null;
  return { base, table: rom.r24(base + 4) };
}

const readsAn2 = (e: ExSlot) => kindOf(e.type) === 'tiles' && !(e.dest & 0x8000) && e.frames.some((f) => f >= AN2_FRAMES && f < AN2_FRAMES_END);

// moves AN2 into the Anim graphics and removes the patch; the levels whose AN2 it moved, notes on slots
// left out (null: no AN2 patch)
export function migrateAn2(rom: Rom): { levels: number[]; notes: string[] } | null {
  const p = an2Patch(rom);
  if (!p) return null;
  const levels: number[] = [], notes: string[] = [];
  let emu: LevelEmulator | null = null;
  for (let lv = 0; lv < 512; lv++) {
    const file = rom.r8(p.table + lv);
    const list = file !== 0xff ? readLevelList(rom, lv) : null;
    if (!list || ![...list.slots.values()].some(readsAn2)) continue;
    const g = gfxEntry(rom, file);
    // a slot's other RAM frames (the game's graphics) from the level's WRAM after its load
    if (!emu) { emu = new LevelEmulator(rom); emu.boot(); }
    const wram = emu.load(lv).wram;
    const slots = [...list.slots];
    const f = localizeFrames(rom, slots.map(([, e]) => e), { an2: g?.raw ? rom.bytes(g.addr, 0x1000) : null, ram: wram }, list.altFile);
    list.slots = new Map(slots.flatMap(([k], i) => f.slots[i] ? [[k, f.slots[i]!] as const] : []));
    writeLevelList(rom, lv, list);
    levels.push(lv);
    notes.push(...f.notes.map((n) => `Level ${lv.toString(16).toUpperCase().padStart(3, '0')}: ${n}`));
  }
  rom.writeBytes(HOOK, Uint8Array.from(ORIG));
  rom.freeAt(p.base);
  return { levels, notes };
}
