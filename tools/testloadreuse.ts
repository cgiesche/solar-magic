// A level load taking over frames of the emulator's previous load (#448, LevelEmulator.reuseLoads): each frame of a
// load is emulated only when something it reads differs from the previous load's frame at the same place.
// - every load is exactly a whole load on an emulator without reuse: the LevelRender (WRAM, VRAM, CGRAM, the PPU
//   registers, the objects' tiles, the frames) and the console's state after it
// - the same input again: no frame emulated
// node tools/testloadreuse.ts
import { LevelEmulator, type LevelRender } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { loadLevel, type Level } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import type { SnesState } from '../src/core/snes.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom((await editorImage()).slice());
const emu = new LevelEmulator(rom);
emu.reuseLoads = true;
emu.boot();
const whole = new LevelEmulator(rom); // the reference: every load emulated whole
whole.adoptBoot(emu);

const bytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, k: number) => v === b[k]);
const sameSets = (a: Map<number, Set<number>>, b: Map<number, Set<number>>) =>
  a.size === b.size && [...a].every(([k, s]) => { const t = b.get(k); return !!t && t.size === s.size && [...s].every((o) => t.has(o)); });
// what differs between two renders and the console states after them ('' when nothing)
function differs(a: LevelRender, sa: SnesState, b: LevelRender, sb: SnesState): string {
  const out: string[] = [];
  for (const k of ['wram', 'vram', 'cgram', 'cgramSrc', 'ppuRegs', 'owner'] as const) if (!bytes(a[k], b[k])) out.push(k);
  if (!sameSets(a.touched, b.touched)) out.push('touched');
  if (a.ok !== b.ok || a.frames !== b.frames) out.push(`ok/frames ${a.ok}/${a.frames} ${b.ok}/${b.frames}`);
  for (const k of Object.keys(sb)) {
    const x = sa[k], y = sb[k];
    if (x instanceof Uint8Array ? !bytes(x, y as Uint8Array) : x !== y) out.push('state ' + k);
  }
  return out.join(', ');
}
// loads lv on both emulators: what differs, and how many frames the reusing one emulated
function load(lv: Level): { diff: string; emulated: number; frames: number } {
  const ov = levelOverride(rom, lv);
  const a = emu.load(lv.number, ov), sa = emu.snes.saveState();
  const b = whole.load(lv.number, ov), sb = whole.snes.saveState();
  return { diff: differs(a, sa, b, sb), emulated: emu.emulatedFrames, frames: a.frames };
}

// ---- the same input again ----
{
  const lv = loadLevel(rom, 0x105);
  const first = load(lv), again = load(lv);
  check(!first.diff && first.emulated === first.frames, `105 loaded the first time: a whole load, every frame emulated (${first.emulated}/${first.frames}) ${first.diff}`);
  check(!again.diff && again.emulated === 0, `105 again: the same, no frame emulated (${again.emulated}/${again.frames}) ${again.diff}`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exit(1);
