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
import { FG_PALS, PAL_SIZE } from '../src/core/sharedpal.ts';
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

// ---- every object moved a tile, as a drag's steps: each load after the last one ----
// (the frames before the objects' and those after them take over: only the objects' frames are emulated, unless
// the move changes what the start screens show)
{
  const lv = loadLevel(rom, 0x105);
  load(lv);
  const counts: number[] = [];
  let wrong = '';
  for (const o of lv.objects) {
    o.x++;
    const r = load(lv);
    o.x--;
    if (r.diff && !wrong) wrong = `${o.num.toString(16)}/${o.ext.toString(16)} at ${o.x},${o.y}: ${r.diff}`;
    counts.push(r.emulated);
  }
  const sorted = counts.slice().sort((a, b) => a - b), median = sorted[sorted.length >> 1];
  check(!wrong, `105: each of its ${lv.objects.length} objects moved a tile, every load the same as a whole load ${wrong}`);
  check(median <= 8, `105: a move emulates few frames (median ${median}, most ${sorted.at(-1)} of ${load(lv).frames})`);
}

// ---- other kinds of levels and edits: every load the same as a whole load ----
// 106: layer 2 BG, 0C2: vertical, 0E7: vertical with layer 2 objects, 01F: layer 3 image, 127: tides
{
  let wrong = '', loads = 0;
  const see = (what: string, r: { diff: string }) => { loads++; if (r.diff && !wrong) wrong = `${what}: ${r.diff}`; };
  for (const n of [0x106, 0x0c2, 0x0e7, 0x01f, 0x127]) {
    const lv = loadLevel(rom, n), name = n.toString(16);
    see(name, load(lv));
    for (let i = 0; i < lv.objects.length; i += 3) {
      const o = lv.objects[i];
      o.y++; see(`${name} object ${i} moved down`, load(lv)); o.y--;
    }
    for (let i = 0; i < (lv.layer2Objects?.length ?? 0); i += 3) {
      const o = lv.layer2Objects![i];
      o.x++; see(`${name} layer 2 object ${i} moved`, load(lv)); o.x--;
    }
    // deleted, and put back
    const gone = lv.objects.splice(lv.objects.length >> 1, 1);
    see(`${name} an object deleted`, load(lv));
    lv.objects.splice(lv.objects.length >> 1, 0, ...gone);
    see(`${name} put back`, load(lv));
    // sprites moved
    for (const s of lv.sprites.slice(0, 4)) { s.x++; see(`${name} a sprite moved`, load(lv)); s.x--; }
    // the header: another FG palette, another tileset
    const h = lv.header, fg = h.fgPalette, ts = h.tileset;
    h.fgPalette = (fg + 1) & 7; see(`${name} another FG palette`, load(lv)); h.fgPalette = fg;
    h.tileset = ts === 0 ? 1 : 0; see(`${name} another tileset`, load(lv)); h.tileset = ts;
    see(`${name} as it was`, load(lv));
  }
  check(!wrong, `levels 106, 0C2, 0E7, 01F, 127: objects of both layers moved, deleted, sprites moved, the header changed – ${loads} loads the same as whole loads ${wrong}`);
}

// ---- another level loaded in between, and the ROM changed: the same as a whole load ----
{
  const a = loadLevel(rom, 0x105), b = loadLevel(rom, 0x106);
  load(a);
  const other = load(b), back = load(a);
  check(!other.diff && !back.diff, `105, then 106, then 105 again: the same as whole loads ${other.diff} ${back.diff}`);
  const at = FG_PALS + a.header.fgPalette * PAL_SIZE + 4, was = rom.r8(at);
  const before = emu.load(0x105, levelOverride(rom, a)).cgram.slice();
  rom.w8(at, was ^ 0x1f);
  const changed = load(a), cg = emu.load(0x105, levelOverride(rom, a)).cgram;
  check(!changed.diff && changed.emulated > 0 && !bytes(before, cg),
    `a color of 105's FG palette changed in the ROM: emulated again (${changed.emulated} frames), the same as a whole load ${changed.diff}`);
  rom.w8(at, was);
  const undone = load(a);
  check(!undone.diff, `the color back: the same as a whole load ${undone.diff}`);
}

// ---- reuse off: every frame emulated ----
{
  const plain = new LevelEmulator(rom);
  plain.adoptBoot(emu);
  const lv = loadLevel(rom, 0x105), ov = levelOverride(rom, lv);
  const r1 = plain.load(0x105, ov), n1 = plain.emulatedFrames, r2 = plain.load(0x105, ov);
  check(n1 === r1.frames && plain.emulatedFrames === r2.frames, `reuse off: every frame emulated (${n1}/${r1.frames}, ${plain.emulatedFrames}/${r2.frames})`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exit(1);
