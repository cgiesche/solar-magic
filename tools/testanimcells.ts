// Animation frames drawn cell by cell (animatedPixels): only the 16x16 cells drawing an 8x8 tile whose graphics
// or colors an animation step changes are drawn anew – the pixels that change are exactly those that a
// render of the whole level with the step's VRAM and CGRAM changes (layer 1, layer 2 objects or the BG,
// layer 3 tides and images, ghosted layers).
import { LevelEmulator } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { renderLevel, composite, animatedPixels, type LevelImages } from '../src/core/render.ts';
import { loadLevel, levelRows } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
const rom = new Rom((await editorImage()).slice());
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const emu = new LevelEmulator(rom);
emu.boot();

const looks: [string, (li: LevelImages) => Uint32Array][] = [
  ['all layers', (li) => composite(li)],
  ['layer 1 ghosted', (li) => composite(li, true, true, 1, true)],
  ['layer 2 ghosted, no layer 3', (li) => composite(li, true, true, 2, false)],
];
// 105: plain, 106: layer 2 BG, 001: layer 2 objects, 127/002: tides, 01F/009/011: layer 3 images, 0C2: vertical, 0E7: vertical with layer 2 objects
for (const level of [0x105, 0x106, 0x001, 0x127, 0x002, 0x01f, 0x009, 0x011, 0x0c2, 0x0e7]) {
  const lv = loadLevel(rom, level);
  const r = emu.load(level);
  const li = renderLevel(rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
  const snaps = emu.animationFrames(16, 8);
  for (const [what, look] of looks) {
    const base = look(li);
    let steps = 0, same = 0, changed = 0, fallback = 0;
    for (const s of snaps) {
      const full = look(renderLevel(rom, { ...r, vram: s.vram, cgram: s.cgram }, lv.header.mode, lv.header.screens, levelRows(lv.secondary)));
      const want: number[] = [];
      for (let k = 0; k < full.length; k++) if (full[k] !== base[k]) want.push(k);
      const got = animatedPixels(rom, r, li, base, s.vram, s.cgram, look);
      if (!got) { fallback++; continue; }
      steps++;
      changed += want.length;
      if (got.idx.length === want.length && want.every((k, j) => got.idx[j] === k && got.val[j] === full[k])) same++;
    }
    check(same === steps && steps + fallback === snaps.length, `level ${level.toString(16)}, ${what}: ${same}/${steps} steps the same as drawn whole (${changed} pixels changed${fallback ? `, ${fallback} drawn whole` : ''}, ${li.geom1.vertical ? 'vertical' : 'horizontal'}${li.layer3 ? ', layer 3' : ''})`);
  }
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
