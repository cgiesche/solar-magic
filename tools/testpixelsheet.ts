// The pixel editor's model (core/pixelsheet.ts, #555): what pen, eraser and fill reach (the pixel selection, else the
// tiles the pixel editor shows), the float (it lies over the file for everything that reads, it stays inside the area, put down it is the edit, dropped it leaves the file as it was), Del (a
// pasted float dropped without an edit, a lifted one gone with where it came from transparent), the clipboard (the
// area grown to hold it), flips and the rotation of squares only, and the sheet's brush (cut at the sheet's edge and
// the file's end).
// node tools/testpixelsheet.ts
import { PixelSheet } from '../src/core/pixelsheet.ts';
import type { GfxFile } from '../src/core/gfxfiles.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const file = (tiles = 128, num = 0x80): GfxFile => ({ num, addr: 0, raw: true, bpp: 4, auto: 4, packed: 0, pix: new Uint8Array(tiles * 64), tiles, empty: false });
// a sheet with the 2x2 tiles at tile (1, 1) in the pixel editor: pixels 8..23 each way
const sheet = (tiles = 128): PixelSheet => {
  const s = new PixelSheet();
  s.area = { x: 1, y: 1, w: 2, h: 2 };
  s.open(file(tiles));
  return s;
};
const count = (s: PixelSheet, v: number) => s.file!.pix.reduce((n, p) => n + (p === v ? 1 : 0), 0);
const same = (a: object | null, b: object) => JSON.stringify(a) === JSON.stringify(b);

// ---------- pen and fill ----------
{
  const s = sheet();
  s.dot(8, 8, 3);
  s.dot(7, 8, 3);
  check(s.get(8, 8) === 3 && s.get(7, 8) === 0, 'the pen paints inside the pixel editor\'s tiles, not beside them');
  const c = s.lineTo(8, 12, 5);
  check(count(s, 5) === 3 && s.get(8, 12) === 5, 'a line from a point outside the tiles: only what is inside is painted');
  check(same(c.rect, { x: 7, y: 8, w: 2, h: 5 }) && c.label === undefined, 'a stroke answers its rectangle, and no edit (the caller stores it at its end)');
  s.dot(10, 10, 1);
  s.lineTo(13, 10, 1);
  check([10, 11, 12, 13].every((x) => s.get(x, 10) === 1), 'a line from the pen\'s last point');
  s.open(file(128, 0x81));
  s.lineTo(20, 20, 2);
  check(s.get(20, 20) === 2 && count(s, 2) === 1, 'another file: the last point is forgotten, a line is one pixel');
}
{
  const s = sheet();
  const c = s.fill(10, 10, 4);
  check(count(s, 4) === 16 * 16 && c.label === 'Fill', 'fill without a pixel selection: the pixel editor\'s tiles, an edit');
  s.sel = { x: 10, y: 10, w: 3, h: 2 };
  s.fill(11, 11, 6);
  check(count(s, 6) === 6 && s.get(9, 10) === 4, 'fill with a pixel selection: only it');
  s.dot(9, 10, 7);
  check(s.get(9, 10) === 4, 'the pen with a pixel selection: only it');
  s.sel = null;
  s.dot(12, 12, 9);
  s.fill(8, 8, 2);
  check(s.get(12, 12) === 9 && s.get(11, 11) === 6 && count(s, 2) === 16 * 16 - 7, 'fill takes the connected pixels of one color');
}
{
  // a file of 24 tiles: the second row of tiles ends after 8, the area reaches past it
  const s = new PixelSheet();
  s.area = { x: 6, y: 1, w: 4, h: 1 };
  s.open(file(24));
  s.fill(48, 8, 3);
  check(count(s, 3) === 2 * 64 && s.get(64, 8) === 0, 'fill next to the file\'s end: what is in the file, and it ends');
  check(s.height === 16, 'a file of 24 tiles is two rows high');
}

// ---------- pixel selection and float ----------
{
  const s = sheet();
  s.select(2, 2, 100, 12);
  check(same(s.sel, { x: 8, y: 8, w: 16, h: 5 }), 'a pixel selection is kept inside the pixel editor\'s tiles');
  s.select(12, 12, 10, 10);
  check(same(s.sel, { x: 10, y: 10, w: 3, h: 3 }), 'a pixel selection from any corner');
  check(s.grabs(11, 11) && !s.grabs(13, 13), 'a press on the pixel selection grabs it, beside it not');
}
{
  const s = sheet();
  s.dot(10, 10, 5);
  s.dot(20, 20, 8);
  s.sel = { x: 10, y: 10, w: 2, h: 2 };
  const l = s.lift('Selection moved');
  check(!!s.float && s.file!.pix.every((p) => p === 0 || p === 8) && s.get(10, 10) === 5, 'lifted: the file is transparent there, the picture still shows the pixels');
  check(l !== null && l.label === undefined && s.lift('again') === null, 'lifting is no edit; a float is lifted once');
  s.moveFloat(19, 19);
  check(s.get(19, 19) === 5 && s.get(20, 20) === 0 && s.get(10, 10) === 0 && count(s, 8) === 1, 'the float moved: its pixels shown over the file\'s, color 0 too; the file not changed yet');
  check(s.grabs(20, 20) && !s.grabs(10, 10), 'a press on the float grabs it; where it came from no more');
  s.moveFloat(100, -5);
  check(s.float!.x === 22 && s.float!.y === 8, 'the float is kept inside the pixel editor\'s tiles');
  s.moveFloat(19, 19);
  const d = s.drop();
  check(d?.label === 'Selection moved' && !s.float && same(s.sel, { x: 19, y: 19, w: 2, h: 2 }), 'put down: the edit under its name, the float is the pixel selection');
  check(s.file!.pix.filter((p) => p).length === 1 && s.get(19, 19) === 5, 'put down: all its pixels in the file, color 0 too');
  check(same(d!.rect, { x: 10, y: 10, w: 11, h: 11 }), 'put down: the rectangle holds where it came from and where it lies');
  check(s.drop() === null && s.cancel() === null, 'no float: nothing to put down or drop');
}
{
  const s = sheet();
  s.dot(10, 10, 5);
  s.sel = { x: 10, y: 10, w: 2, h: 2 };
  s.lift('Selection moved');
  s.moveFloat(15, 15);
  const c = s.cancel();
  check(c !== null && c.label === undefined && !s.float && !s.sel, 'a float dropped: no edit, no float, no pixel selection');
  check(s.get(10, 10) === 5 && count(s, 5) === 1, 'a float dropped: the file as it was');
}
{
  // the file read again while a float is lifted (a ROM change): the file as read has what was lifted
  const s = sheet();
  s.dot(10, 10, 5);
  const stored = file();
  stored.pix.set(s.file!.pix);
  s.sel = { x: 10, y: 10, w: 1, h: 1 };
  s.lift('Selection moved');
  stored.pix[stored.pix.indexOf(5) + 1] = 9;
  s.open(stored);
  s.cancel();
  check(count(s, 5) === 1 && count(s, 9) === 1, 'the file read again under a float: dropping the float leaves it as read');
}

// ---------- clipboard, Del ----------
{
  const s = sheet();
  check(!s.copied && s.paste() === null, 'nothing copied: nothing pasted');
  s.dot(8, 8, 5);
  check(same(s.copy(), { w: 16, h: 16 }), 'copy without a pixel selection: the pixel editor\'s tiles');
  s.sel = { x: 8, y: 8, w: 2, h: 1 };
  check(same(s.copy(), { w: 2, h: 1 }), 'copy with a pixel selection: it');
  s.sel = { x: 23, y: 23, w: 1, h: 1 };
  const p = s.paste();
  check(!!s.float?.pasted && s.float.x === 22 && s.float.y === 23 && p?.label === undefined, 'pasted: a float at the pixel selection, kept inside the tiles, no edit yet');
  check(s.get(22, 23) === 5 && count(s, 5) === 1, 'pasted: shown, not in the file yet');
  check(s.clearDrops, 'Del on a pasted float only drops it');
  const c = s.clear();
  check(c.label === undefined && !s.float && count(s, 5) === 1, 'Del on a pasted float: dropped, the file untouched, no edit');
  s.sel = { x: 8, y: 8, w: 1, h: 1 };
  s.paste();
  s.moveFloat(10, 10);
  check(s.drop()?.label === 'Pasted' && s.get(10, 10) === 5 && s.get(8, 8) === 5, 'a pasted float put down: an edit, nothing taken away elsewhere');
}
{
  const s = sheet();
  s.dot(8, 8, 5); s.dot(9, 8, 5); s.dot(20, 20, 5);
  s.sel = { x: 8, y: 8, w: 1, h: 1 };
  const c = s.clear();
  check(c.label === 'Erase' && count(s, 5) === 2 && !s.clearDrops, 'Del with a pixel selection: it transparent, an edit');
  s.sel = { x: 9, y: 8, w: 1, h: 1 };
  s.lift('Selection moved');
  s.moveFloat(12, 12);
  const l = s.clear();
  check(l.label === 'Erase' && !s.float && !s.sel && count(s, 5) === 1, 'Del on a lifted float: gone, where it came from transparent, an edit');
  s.clear();
  check(count(s, 5) === 0, 'Del without a pixel selection: the pixel editor\'s tiles');
}
{
  const s = new PixelSheet();
  s.area = { x: 0, y: 0, w: 2, h: 2 };
  s.open(file());
  s.dot(15, 15, 5);
  s.copy();
  s.area = { x: 15, y: 7, w: 1, h: 1 };
  s.sel = { x: 120, y: 56, w: 2, h: 2 };
  s.paste();
  check(same(s.area, { x: 14, y: 6, w: 2, h: 2 }) && !s.sel, 'pasting more than the pixel editor shows: its tiles grow, inside the file; the pixel selection ends');
  check(s.float!.x === 112 && s.float!.y === 48, 'and the float is at their top left');
}

// ---------- flips and rotation ----------
{
  const s = sheet();
  s.dot(8, 8, 5);
  const c = s.transform('h');
  check(c?.label === 'Flipped' && s.get(23, 8) === 5 && count(s, 5) === 1 && !s.sel && !s.float, 'a flip without a pixel selection: the pixel editor\'s tiles, an edit, no pixel selection after');
  s.transform('v');
  check(s.get(23, 23) === 5 && count(s, 5) === 1, 'flipped vertically');
  check(s.transform('r')?.label === 'Rotated' && s.get(8, 23) === 5 && count(s, 5) === 1, 'a square rotated by 90° clockwise');
  s.sel = { x: 8, y: 22, w: 2, h: 2 };
  s.transform('h');
  check(s.get(9, 23) === 5 && same(s.sel, { x: 8, y: 22, w: 2, h: 2 }), 'a flip with a pixel selection: it, and it stays');
  s.sel = { x: 8, y: 22, w: 3, h: 2 };
  check(!s.rotates && s.transform('r') === null && s.get(9, 23) === 5, 'what is not a square is not rotated');
  s.copy();
  s.paste();
  check(s.transform('h')?.label === 'Flipped' && !s.float && s.get(9, 23) === 5, 'a float flipped is put down');
}

// ---------- the sheet's brush ----------
{
  const s = new PixelSheet();
  s.area = { x: 1, y: 0, w: 2, h: 2 };
  s.open(file(24));
  s.dot(8, 0, 5); s.dot(23, 0, 6);
  const b = s.brush();
  check(b.w === 16 && b.h === 16, 'the brush: the pixel editor\'s tiles');
  const c = s.stamp(b, 15, 0);
  check(s.get(120, 0) === 5 && count(s, 6) === 1 && c.label === undefined, 'stamped at the sheet\'s right edge: cut there, no edit yet');
  const snap = s.snapshot();
  s.stamp(b, 7, 1);
  check(s.get(56, 8) === 5 && s.get(71, 8) === 0, 'stamped over the file\'s end: what is in the file');
  s.restore(snap);
  check(s.get(56, 8) === 0 && s.get(120, 0) === 5, 'a snapshot put back: the pixels as they were');
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
