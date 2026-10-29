// The level's animation in pictures of its Map16 tiles (TileAnimation, the pickers'): after any sequence of
// steps, and back to the level as rendered, a picture redrawn tile by tile is the same as one drawn whole with
// that step – FG pages, the BG sheet, a sparse picture on a transparent background (an object's thumbnail).
import { LevelEmulator } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { TileAnimation, TileCache, map16Source, drawMap16, charBase, sheetCells, type TilePicture, type AnimStep } from '../src/core/render.ts';
import type { LevelRender } from '../src/core/levelemu.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
const rom = new Rom((await editorImage()).slice());
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const emu = new LevelEmulator(rom);
emu.boot();

// a picture drawn whole with step s (null: the render's own VRAM and CGRAM)
function drawn(r: LevelRender, s: AnimStep | null, cells: number[], w: number, h: number, bg: boolean, back: number): Uint32Array {
  const v = s ?? r, src = map16Source(rom, r);
  const tc = new TileCache(v.vram, v.cgram, charBase(r, bg));
  const px = new Uint32Array(w * h).fill(back);
  for (let i = 0; i < cells.length; i += 3) drawMap16(px, w, h, tc, bg ? src.bg(cells[i + 2]) : src.fg(cells[i + 2]), cells[i], cells[i + 1]);
  return px;
}
const sheet = sheetCells;

// 105: FG with coins and ? blocks, 106: an animated BG, 127: tides
for (const [level, bg, cells, w, h, back, what] of [
  [0x105, false, sheet(0, 512), 256, 512, 0xff181818, 'FG pages 0–1'],
  [0x106, true, sheet(0, 512), 256, 512, 0xff181818, 'BG sheet'],
  [0x127, false, sheet(0, 512), 256, 512, 0xff181818, 'FG pages 0–1'],
  [0x105, false, [0, 0, 0x2b, 16, 0, 0x11f, 32, 16, 0x25, 0, 16, 0x166], 48, 32, 0, 'a sparse picture, transparent'],
] as [number, boolean, number[], number, number, number, string][]) {
  const r = emu.load(level);
  const steps = emu.animationFrames(16, 8);
  const anim = new TileAnimation(rom, r);
  const pic: TilePicture = { px: drawn(r, null, cells, w, h, bg, back), w, h, cells, bg, back };
  const level0 = drawn(r, null, cells, w, h, bg, back);
  let same = 0, redrawn = 0, changing = 0;
  // in order, backwards, skipping, then back to the render
  const order: (AnimStep | null)[] = [...steps, ...[...steps].reverse(), steps[3], steps[11], steps[0], null];
  let from: AnimStep | null = null;
  for (const to of order) {
    if (anim.redraw(pic, from, to)) redrawn++;
    const want = drawn(r, to, cells, w, h, bg, back);
    if (want.every((v, i) => v === pic.px[i])) same++;
    if (to && !want.every((v, i) => v === level0[i])) changing++;
    from = to;
  }
  // drawn with another render (here: garbage), every tile drawn anew
  pic.px.fill(0x12345678);
  anim.redraw(pic, steps[5], steps[2], true);
  const whole = drawn(r, steps[2], cells, w, h, bg, back).every((v, i) => v === pic.px[i]);
  check(whole, `level ${level.toString(16)}, ${what}: all tiles redrawn for a picture of another render`);
  check(same === order.length && changing > 0, `level ${level.toString(16)}, ${what}: ${same}/${order.length} steps the same as drawn whole (${changing} look different from the level, ${redrawn} redrawn)`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
