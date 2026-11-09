// The level image brought to an edit's new load cell by cell (#445, core/render.ts patchLevel): only the 16x16 cells
// that look different (found by comparing the two loads' tilemaps and video memory) are drawn anew.
// - objects moved or deleted: the patched layers, tiles and composite (composeCells) are exactly a whole redraw of the
//   new load (renderLevel, composite) – horizontal and vertical levels, the BG, layer 2 objects, layer 3
// - the animation's frames patched in the cells drawn anew (patchFrame: animatedPixels within them) are exactly the
//   frames built anew for the new load, whenever the steps carry over (LevelAnimSteps.carry)
// - a drag: each step's load patched over the image the last step patched
// - a load the cells can't follow (another backdrop color): drawn whole (null)
// node tools/testlevelpatch.ts
import { LevelEmulator, type LevelRender } from '../src/core/levelemu.ts';
import { LevelAnimSteps } from '../src/core/levelanimsteps.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { renderLevel, composite, composeCells, patchLevel, patchFrame, animatedPixels, copyImages, type LevelImages, type PixelChanges } from '../src/core/render.ts';
import { loadLevel, levelRows, cloneLevel, type Level } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { RAM } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom((await editorImage()).slice());
const emu = new LevelEmulator(rom);
emu.boot();
const STEPS = 4;

const same = (a: ArrayLike<number> | null, b: ArrayLike<number> | null, n: number) => {
  for (let k = 0; k < n; k++) if ((a ? a[k] : 0) !== (b ? b[k] : 0)) return false;
  return true;
};
const sameImages = (a: LevelImages, b: LevelImages) => {
  const n = a.width * a.height;
  return a.width === b.width && a.height === b.height && a.backdrop === b.backdrop && same(a.layer1, b.layer1, n) && same(a.layer2, b.layer2, n)
    && same(a.layer3?.back ?? null, b.layer3?.back ?? null, n) && same(a.layer3?.front ?? null, b.layer3?.front ?? null, n)
    && same(a.tiles1, b.tiles1, a.tiles1.length) && (!a.tiles2 || same(a.tiles2, b.tiles2, a.tiles2.length))
    && (!a.bgTiles || same(a.bgTiles, b.bgTiles, a.bgTiles.length));
};
const copy = copyImages;
const draw = (lv: Level, r: LevelRender) => renderLevel(rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
const looks: [string, (li: LevelImages) => Uint32Array, (li: LevelImages, out: Uint32Array, c: Uint8Array) => void][] = [
  ['all layers', (li) => composite(li), (li, out, c) => composeCells(li, out, c)],
  ['layer 1 ghosted, no layer 3', (li) => composite(li, true, true, 1, false), (li, out, c) => composeCells(li, out, c, true, true, 1, false)],
];
const sameFrame = (a: PixelChanges, b: PixelChanges) =>
  a.idx.length === b.idx.length && same(a.idx, b.idx, a.idx.length) && same(a.val, b.val, a.val.length);

// 105: plain, 106: layer 2 BG, 127: tides, 01F/011: layer 3 images, 0C2: vertical, 0E7: vertical with layer 2 objects
for (const n of [0x105, 0x106, 0x127, 0x01f, 0x011, 0x0c2, 0x0e7]) {
  const lv = loadLevel(rom, n);
  const r0 = emu.load(n, levelOverride(rom, lv));
  const li0 = draw(lv, r0);
  const steps = new LevelAnimSteps(emu, STEPS);
  while (steps.next());
  const bases = looks.map(([, look]) => look(li0));
  const frames0 = looks.map(([, look], j) => steps.steps.map((s) => animatedPixels(rom, r0, li0, bases[j], s.vram, s.cgram, look)));
  let tried = 0, patched = 0, same1 = 0, sameLook = 0, framesTried = 0, framesSame = 0, cellsDrawn = 0;
  const pick = [...new Set([0, 1, Math.floor(lv.objects.length / 3), Math.floor(lv.objects.length / 2), lv.objects.length - 2])].filter((i) => i >= 0 && i < lv.objects.length);
  for (const i of pick) {
    for (const edit of ['right', 'down', 'delete'] as const) {
      const e = cloneLevel(lv);
      if (edit === 'delete') e.objects.splice(i, 1);
      else if (edit === 'right') e.objects[i].x++;
      else e.objects[i].y++;
      const r1 = emu.load(n, levelOverride(rom, e));
      const kept = steps.carry(emu, STEPS);
      tried++;
      const full = draw(e, r1);
      const li = copy(li0);
      const p = patchLevel(rom, r0, li, r1);
      if (!p) continue;
      patched++;
      cellsDrawn += p.cells.reduce((a, b) => a + b, 0);
      if (sameImages(p.images, full)) same1++;
      let lookOk = true;
      looks.forEach(([, look, cells], j) => {
        const base = bases[j].slice();
        cells(p.images, base, p.cells);
        const want = look(full);
        if (!same(base, want, want.length)) lookOk = false;
        if (!kept) return;
        // the frames: those of the old composite patched in the cells drawn anew, as built anew for the new load
        kept.steps.forEach((s, k) => {
          const old = frames0[j][k], fresh = animatedPixels(rom, r1, full, want, s.vram, s.cgram, look);
          if (!old || !fresh) return;
          const inside = animatedPixels(rom, r1, p.images, base, s.vram, s.cgram, look, p.cells);
          framesTried++;
          if (inside && sameFrame(patchFrame(old, inside, p.cells, full.width), fresh)) framesSame++;
        });
      });
      if (lookOk) sameLook++;
    }
  }
  check(patched === tried && same1 === patched && sameLook === patched && framesTried > 0 && framesSame === framesTried,
    `level ${n.toString(16)}: ${patched}/${tried} edits patched (${cellsDrawn} cells drawn anew), ${same1} layers and ${sameLook} composites as drawn whole, ${framesSame}/${framesTried} animation frames as built anew (${full(lv)})`);
}
function full(lv: Level): string {
  const im = draw(lv, emu.load(lv.number, levelOverride(rom, lv)));
  return `${im.geom1.vertical ? 'vertical' : 'horizontal'}${im.geom2 ? ', layer 2 objects' : ', BG'}${im.layer3 ? ', layer 3' : ''}`;
}

// a drag: one object moved step by step, each load patched over the last patched image (and its composite)
for (const n of [0x105, 0x0e7, 0x01f]) {
  const lv = loadLevel(rom, n), e = cloneLevel(lv), i = Math.floor(lv.objects.length / 2);
  let r = emu.load(n, levelOverride(rom, e)), li = draw(e, r), base = composite(li), ok = 0, steps = 0;
  for (const [dx, dy] of [[1, 0], [1, 0], [0, -1], [-1, -1], [-1, 1], [0, 1]]) {
    e.objects[i].x += dx; e.objects[i].y += dy;
    const r1 = emu.load(n, levelOverride(rom, e)), full = draw(e, r1);
    const p = patchLevel(rom, r, li, r1);
    steps++;
    if (!p) { li = full; base = composite(full); r = r1; continue; }
    composeCells(p.images, base, p.cells);
    const want = composite(full);
    if (sameImages(p.images, full) && same(base, want, want.length)) ok++;
    li = p.images; r = r1;
  }
  check(ok === steps, `level ${n.toString(16)}, an object dragged ${steps} steps: ${ok} patched images and composites as drawn whole`);
}

// another backdrop color: every cell may look different, drawn whole
{
  const lv = loadLevel(rom, 0x105);
  const r0 = emu.load(0x105, levelOverride(rom, lv)), li0 = draw(lv, r0);
  const r1 = { ...r0, wram: r0.wram.slice() };
  r1.wram[RAM.backdrop] ^= 0x1f;
  check(patchLevel(rom, r0, copy(li0), r1) === null, 'another backdrop color: drawn whole');
  const same0 = patchLevel(rom, r0, copy(li0), r0);
  check(!!same0 && same0.cells.every((c) => !c), 'the same load: no cell drawn anew');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
