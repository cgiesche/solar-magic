// Hovering a palette previews the recolored image (#418), ui/palhover.ts: a palette button entered with no mouse
// button held shows its palette, leaving it or pressing a button ends the preview, a rebuilt button list ends it
// too; the Map16 tab's view while hovering (the marked quarters in the hovered palette, the 8x8 graphics in it,
// the fills hidden; no marks: no preview), the Graphics tab's row (the hovered one, else the chosen one) – the
// words given are never changed.
// node tools/testpalhover.ts
import { PaletteHover, map16Preview, previewRow } from '../src/ui/palhover.ts';
import { QuarterGrid } from '../src/core/quarters.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// a button's listeners, fired by hand
class FakeEl {
  ls = new Map<string, ((e: { buttons: number }) => void)[]>();
  addEventListener(t: string, f: (e: { buttons: number }) => void): void { this.ls.set(t, [...(this.ls.get(t) ?? []), f]); }
  fire(t: string, buttons = 0): void { for (const f of this.ls.get(t) ?? []) f({ buttons }); }
}

// ---------- the hover ----------
{
  const seen: (number | null)[] = [];
  const hov = new PaletteHover((p) => seen.push(p));
  const a = new FakeEl(), b = new FakeEl();
  hov.bind(a as unknown as HTMLElement, 3);
  hov.bind(b as unknown as HTMLElement, 5);
  check(hov.value === null, 'no preview at first');
  a.fire('mouseenter');
  check(hov.value === 3 && seen.join() === '3', 'entering a palette shows it at once');
  a.fire('mouseleave');
  check(hov.value === null && seen.join() === '3,', 'leaving it ends the preview');
  b.fire('mouseenter', 1);
  check(hov.value === null && seen.length === 2, 'entered with a button held (dragging): no preview');
  b.fire('mouseleave', 1);
  check(seen.length === 2, 'leaving without a preview: nothing redrawn');
  b.fire('mouseenter');
  b.fire('mousedown', 1);
  check(hov.value === null && seen.join() === '3,,5,', 'pressing a button ends the preview (the click shows the real result)');
  a.fire('mouseenter');
  b.fire('mouseenter');
  check(hov.value === 5 && seen.join() === '3,,5,,3,5', 'moving straight to another palette shows that one');
  a.fire('mouseleave');
  check(hov.value === 5, 'a late leave of the other button keeps the shown preview');
  hov.reset();
  check(hov.value === null && seen.at(-1) === null, 'reset (the buttons built again) ends the preview');
  const n = seen.length;
  hov.reset();
  check(seen.length === n, 'reset without a preview: nothing redrawn');
}

// ---------- Map16 ----------
{
  const g = new QuarterGrid(2, 1); // two tiles, 4x2 quarters
  // tile 0: tile 0x10 in palette 1 (all quarters), tile 1: tile 0x20 in palette 2; priority and flips kept
  const words = [[0x0410, 0x0411, 0x2412, 0x4413], [0x0820, 0x0821, 0x0822, 0x0823]];
  const before = JSON.stringify(words);
  const marks = new Set([g.key(0, 0), g.key(1, 1)]); // tile 0's TL and BR
  const off = map16Preview(g, words, marks, 2, null);
  check(off.words === words && off.gfxPal === 2 && off.fills && !off.preview, 'not hovering: the tiles as they are, the followed palette, the fills shown');
  const on = map16Preview(g, words, marks, 2, 6);
  check(on.preview && !on.fills, 'hovering: a preview, the fills hidden');
  check(on.words[0][0] === 0x1810 && on.words[0][3] === 0x5813, 'the marked quarters in the hovered palette (tile, flips and priority kept)');
  check(on.words[0][1] === 0x0411 && on.words[0][2] === 0x2412 && JSON.stringify(on.words[1]) === JSON.stringify(words[1]), 'the unmarked quarters as they are');
  check(on.gfxPal === 6, 'the 8x8 graphics in the hovered palette');
  check(JSON.stringify(words) === before, 'the words given are not changed');
  const none = map16Preview(g, words, new Set(), 2, 6);
  check(!none.preview && none.fills && none.words === words && none.gfxPal === 2, 'no marked quarters: no preview at all');
}

// ---------- Graphics ----------
check(previewRow(null, 4) === 4, 'graphics: not hovering, the chosen row');
check(previewRow(0xb, 4) === 0xb, 'graphics: hovering, the hovered row');
check(previewRow(0, 4) === 0, 'graphics: row 0 hovered is a preview too');

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
