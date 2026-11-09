// Hovering a palette previews the recolored image (#418), ui/palhover.ts: a palette button entered with no mouse
// button held shows its palette, leaving it or pressing a button ends the preview; the buttons built again keep it
// while the mouse stays on its palette (the next mouse move decides); the Map16 tab's view while hovering (the marked
// quarters in the hovered palette, the 8x8 graphics in it, the fills hidden; no marks: no preview) – the words given
// are never changed.
// node tools/testpalhover.ts
import { PaletteHover, map16Preview } from '../src/ui/palhover.ts';
import { QuarterGrid } from '../src/core/quarters.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// a button's listeners, fired by hand
type Ev = { buttons: number; target?: unknown };
class FakeEl {
  ls = new Map<string, ((e: Ev) => void)[]>();
  kids: unknown[] = [];
  addEventListener(t: string, f: (e: Ev) => void): void { this.ls.set(t, [...(this.ls.get(t) ?? []), f]); }
  fire(t: string, buttons = 0, target?: unknown): void { const l = this.ls.get(t) ?? []; if (t === 'mousemove') this.ls.delete(t); for (const f of l) f({ buttons, target }); }
  contains(n: unknown): boolean { return n === this || this.kids.includes(n); }
}
const el = (x: FakeEl) => x as unknown as HTMLElement;

// ---------- the hover ----------
{
  const seen: (number | null)[] = [];
  const doc = new FakeEl(); // the document: its mouse moves (each listener once)
  const hov = new PaletteHover((p) => seen.push(p), doc as unknown as Document);
  const a = new FakeEl(), b = new FakeEl();
  hov.bind(el(a), 3);
  hov.bind(el(b), 5);
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
  // the buttons built again (a key, an undo, results arriving) while palette 5 is previewed
  let n = seen.length;
  hov.reset();
  const a2 = new FakeEl(), b2 = new FakeEl(), label = {};
  b2.kids.push(label);
  hov.bind(el(a2), 3); hov.bind(el(b2), 5);
  check(hov.value === 5 && seen.length === n, 'built again: the preview stays (nothing redrawn)');
  doc.fire('mousemove', 0, label);
  check(hov.value === 5 && seen.length === n, 'the next move over the new button of that palette (its label): the preview stays');
  b2.fire('mouseleave');
  check(hov.value === null && seen.at(-1) === null, 'leaving the new button ends it');
  b2.fire('mouseenter');
  hov.reset();
  const a3 = new FakeEl(), b3 = new FakeEl();
  hov.bind(el(a3), 3); hov.bind(el(b3), 5);
  doc.fire('mousemove', 0, a3);
  check(hov.value === 3, 'built again, the next move over another palette\'s button: that one');
  hov.reset();
  hov.reset(); // (built twice before a move: one check)
  const b4 = new FakeEl();
  hov.bind(el(b4), 3);
  doc.fire('mousemove', 0, {});
  check(hov.value === null && seen.at(-1) === null, 'built again, the next move elsewhere: the preview ends (no leave would come)');
  b4.fire('mouseenter');
  hov.reset();
  hov.bind(el(b4), 3);
  doc.fire('mousemove', 1, b4);
  check(hov.value === null, 'built again, the next move with a button held: the preview ends');
  n = seen.length;
  hov.reset();
  check(seen.length === n && (doc.ls.get('mousemove') ?? []).length === 0, 'built again without a preview: nothing redrawn, no move watched');
  const quiet = new PaletteHover((p) => seen.push(p), null);
  const q = new FakeEl();
  quiet.bind(el(q), 2);
  q.fire('mouseenter');
  quiet.reset();
  check(quiet.value === null, 'no document to watch: built again ends the preview');
}

// ---------- Map16 ----------
{
  const g = new QuarterGrid(2, 1); // two tiles, 4x2 quarters
  // tile 0: tile 0x10 in palette 1 (all quarters), tile 1: tile 0x20 in palette 2; priority and flips kept
  const words = [[0x0410, 0x0411, 0x2412, 0x4413], [0x0820, 0x0821, 0x0822, 0x0823]];
  const before = JSON.stringify(words);
  const marks = new Set([g.key(0, 0), g.key(1, 1)]); // tile 0's TL and BR
  const off = map16Preview(g, words, marks, 2, null);
  check(off.words === words && off.gfxPal === 2 && !off.preview, 'not hovering: the tiles as they are, the followed palette, no preview (the fills shown)');
  const on = map16Preview(g, words, marks, 2, 6);
  check(on.preview, 'hovering: a preview (the fills hidden)');
  check(on.words[0][0] === 0x1810 && on.words[0][3] === 0x5813, 'the marked quarters in the hovered palette (tile, flips and priority kept)');
  check(on.words[0][1] === 0x0411 && on.words[0][2] === 0x2412 && JSON.stringify(on.words[1]) === JSON.stringify(words[1]), 'the unmarked quarters as they are');
  check(on.gfxPal === 6, 'the 8x8 graphics in the hovered palette');
  check(JSON.stringify(words) === before, 'the words given are not changed');
  const none = map16Preview(g, words, new Set(), 2, 6);
  check(!none.preview && none.words === words && none.gfxPal === 2, 'no marked quarters: no preview at all');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
