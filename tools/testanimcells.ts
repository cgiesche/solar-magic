// Animation frames drawn cell by cell (animatedPixels): only the 16x16 cells drawing an 8x8 tile whose graphics
// or colors an animation step changes are drawn anew – the pixels that change are exactly those that a
// render of the whole level with the step's VRAM and CGRAM changes (layer 1, layer 2 objects or the BG,
// layer 3 tides and images, ghosted layers). (The steps emulated one at a time: testlevelanimsteps.ts.)
// A step is uploaded as the rectangles around its changed pixels (changedRects, #504): a picture updated only in the
// last step's and the new step's rectangles is the one updated whole.
import { LevelEmulator } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { renderLevel, composite, animatedPixels, changedRects, mergeRects, CHANGE_BLOCK, type LevelImages, type PixelChanges, type PixelRect } from '../src/core/render.ts';
import { loadLevel, levelRows } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
const rom = new Rom((await editorImage()).slice());
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const emu = new LevelEmulator(rom);
emu.boot();

// ---- changedRects: one tight rectangle per block (CHANGE_BLOCK pixels square) with changed pixels ----
{
  const W = 600, at = (x: number, y: number) => y * W + x;
  const rects = (pts: [number, number][]) => changedRects(Uint32Array.from(pts.map(([x, y]) => at(x, y)).sort((a, b) => a - b)), W)
    .map((r) => `${r.x},${r.y} ${r.w}x${r.h}`).sort().join(' | ');
  const B = CHANGE_BLOCK;
  check(changedRects(new Uint32Array(0), W).length === 0, 'changedRects: no pixels, no rectangle');
  check(rects([[5, 7]]) === '5,7 1x1', `changedRects: one pixel (${rects([[5, 7]])})`);
  check(rects([[16, 32], [31, 47], [20, 40], [31, 32]]) === '16,32 16x16', 'changedRects: a cell\'s pixels, one tight rectangle');
  check(rects([[3, 3], [B - 1, B - 1]]) === `3,3 ${B - 3}x${B - 3}`, 'changedRects: pixels of one block share a rectangle');
  check(rects([[B - 1, 4], [B, 4]]) === [`${B - 1},4 1x1`, `${B},4 1x1`].sort().join(' | '), 'changedRects: neighbours in two blocks, two rectangles');
  check(rects([[2, 2], [2 * B + 9, 2], [2, B + 5], [W - 1, 3 * B + 1]]) === ['2,2 1x1', `${2 * B + 9},2 1x1`, `2,${B + 5} 1x1`, `${W - 1},${3 * B + 1} 1x1`].sort().join(' | '),
    'changedRects: far apart pixels (the last column, a row beyond the others), a rectangle each');
  const list = (rs: PixelRect[]) => rs.map((r) => `${r.x},${r.y} ${r.w}x${r.h}`).sort().join(' | ');
  const a = changedRects(Uint32Array.from([at(B + 1, 1), at(4, 4), at(9, 6)]), W), b = changedRects(Uint32Array.from([at(2, 5), at(6, 20), at(1, B)]), W);
  check(list(mergeRects(a, b)) === ['2,4 8x17', `${B + 1},1 1x1`, `1,${B} 1x1`].sort().join(' | '), `mergeRects: a block's rectangles of both as one, the others kept (${list(mergeRects(a, b))})`);
  check(mergeRects(a, []) === a && mergeRects([], b) === b, 'mergeRects: an empty list changes nothing');
}

// a step shown on `shown` as the level view does: only the rectangles copied from the picture
const copyRects = (shown: Uint32Array, img: Uint32Array, width: number, rects: PixelRect[]) => {
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) shown.set(img.subarray(y * width + r.x, y * width + r.x + r.w), y * width + r.x);
};
const equal = (a: Uint32Array, b: Uint32Array) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false; return true; };

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
    const frames: PixelChanges[] = [];
    for (const s of snaps) {
      const full = look(renderLevel(rom, { ...r, vram: s.vram, cgram: s.cgram }, lv.header.mode, lv.header.screens, levelRows(lv.secondary)));
      const want: number[] = [];
      for (let k = 0; k < full.length; k++) if (full[k] !== base[k]) want.push(k);
      const got = animatedPixels(rom, r, li, base, s.vram, s.cgram, look);
      if (!got) { fallback++; continue; }
      frames.push(got);
      steps++;
      changed += want.length;
      if (got.idx.length === want.length && want.every((k, j) => got.idx[j] === k && got.val[j] === full[k])) same++;
    }
    check(same === steps && steps + fallback === snaps.length, `level ${level.toString(16)}, ${what}: ${same}/${steps} steps the same as drawn whole (${changed} pixels changed${fallback ? `, ${fallback} drawn whole` : ''}, ${li.geom1.vertical ? 'vertical' : 'horizontal'}${li.layer3 ? ', layer 3' : ''})`);
    // the frames cycled (twice, back to the first) as App.animTick does, shown by their rectangles only
    const W = li.width, H = li.height, rects = frames.map((f) => changedRects(f.idx, W));
    const inside = rects.every((rs) => rs.every((r) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= W && r.y + r.h <= H && r.w <= CHANGE_BLOCK && r.h <= CHANGE_BLOCK));
    const img = base.slice(), shown = base.slice();
    let ok = 0, area = 0, ticks = 0, prev = -1;
    for (let t = 0; t < 2 * frames.length + 1; t++) {
      const n = t % frames.length, f = frames[n], p = prev >= 0 ? frames[prev] : null;
      if (p) for (const k of p.idx) img[k] = base[k];
      for (let j = 0; j < f.idx.length; j++) img[f.idx[j]] = f.val[j];
      const rs = p ? mergeRects(rects[prev], rects[n]) : rects[n];
      copyRects(shown, img, W, rs);
      for (const r of rs) area += r.w * r.h;
      if (equal(shown, img)) ok++;
      ticks++; prev = n;
    }
    if (frames.length) check(inside && ok === ticks, `level ${level.toString(16)}, ${what}: ${ok}/${ticks} steps shown by their rectangles are the picture (${(100 * area / (ticks * W * H)).toFixed(1)}% of ${W}x${H} uploaded per step)`);
  }
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
