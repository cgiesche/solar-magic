// Running selection outlines in dense picker sheets (ui/ants.ts): drawn on an overlay over the sheet in device pixels,
// one look on every sheet (a line of whole device pixels, dashes of 4 screen pixels rounded to whole ones, the marks'
// edges on whole device pixels whatever the sheet's scaling), all in phase by one central ticker at 10 fps; an overlay
// redrawn on a tick only while it showed a running outline and is visible, no ticks otherwise, the sheet never; the
// switch "Animate selection outlines" (off: the dashes stand still).
// node tools/testants.ts
import { setPrefStorage } from '../src/ui/prefs.ts';
import { antsPhase, antsLook, antsBox, drawAnts, antsDrawn, onAntsTick, animateAnts, antsMenuItem, AntsOverlay, ANTS_DARK, ANTS_PERIOD_MS, type AntsMark } from '../src/ui/ants.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
setPrefStorage(null);

// the page's IntersectionObserver (whether a sheet is on the screen: scrolled into its panel, its panel shown)
class FakeObserver {
  cb: (entries: { target: unknown; isIntersecting: boolean }[]) => void;
  targets = new Set<unknown>();
  constructor(cb: FakeObserver['cb']) { this.cb = cb; observers.push(this); }
  observe(t: unknown) { this.targets.add(t); }
  unobserve(t: unknown) { this.targets.delete(t); }
  disconnect() { this.targets.clear(); }
}
const observers: FakeObserver[] = [];
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
const onScreen = (target: unknown, isIntersecting: boolean) => { for (const o of observers) if (o.targets.has(target)) o.cb([{ target, isIntersecting }]); };

check(ANTS_PERIOD_MS === 100, 'the ticker runs at 10 fps');
check(antsPhase(0) === 0 && antsPhase(99) === 0 && antsPhase(100) === 1 && antsPhase(750) === 7 && antsPhase(800) === 0, 'the phase steps a pixel a tick, over the 8 pixels of a dash and its gap');
{
  const l1 = antsLook(1), l125 = antsLook(1.25), l2 = antsLook(2), l3 = antsLook(3);
  check(l1.lw === 2 && l125.lw === 2 && l2.lw === 2 && l3.lw === 3, 'the line: whole device pixels, a screen pixel but at least 2 (2 at a scaling of 2, as the level pickers had it)');
  check(l1.dash === 4 && l125.dash === 5 && l2.dash === 8 && l3.dash === 12, 'the dash: 4 screen pixels in whole device pixels');
}

// the marks on the overlay: edges on whole device pixels, the line covering whole pixels inside them
{
  const m: AntsMark = { x: 3, y: 1, w: 2, h: 1, color: '#fff' };
  // a 16×16 cell page on 301×301 device pixels (a cell 18.8 device pixels)
  const [x, y, w, h] = antsBox(m, 301, 301, 16, 16, 2);
  check(x === 57 && y === 20 && w === 38 - 2 && h === 19 - 2, `a rectangle of cells in device pixels, the line inside (${x},${y},${w},${h})`);
  check(Number.isInteger(x - 1) && Number.isInteger(x + w + 1) && Number.isInteger(y - 1) && Number.isInteger(y + h + 1), 'the line\'s edges on whole device pixels');
  const odd = antsBox(m, 301, 301, 16, 16, 3);
  check(Number.isInteger(odd[0] - 1.5) && Number.isInteger(odd[0] + odd[2] + 1.5), 'an odd line width too');
  const o = antsBox({ ...m, out: true }, 301, 301, 16, 16, 2);
  check(o[0] === 55 && o[1] === 18 && o[2] === 38 + 2 && o[3] === 19 + 2, `out: around the rectangle (${o.join()})`);
  const edge = antsBox({ x: 0, y: 0, w: 16, h: 16, color: '#fff', out: true }, 301, 301, 16, 16, 2);
  check(edge.join() === '1,1,299,299', `out at the overlay's edges: inside there (${edge.join()})`);
  const scaled = antsBox(m, 150, 150, 16, 16, 2), big = antsBox(m, 602, 602, 16, 16, 2);
  check(scaled[2] + 2 === Math.round(5 * 150 / 16) - Math.round(3 * 150 / 16) && big[2] + 2 === Math.round(5 * 602 / 16) - Math.round(3 * 602 / 16), 'at any size of the sheet');
}

// a fake context recording what is drawn
type Call = [string, string];
function fakeCtx() {
  const calls: Call[] = [];
  return {
    calls, lineWidth: 1, strokeStyle: '', lineDashOffset: 0, dash: [] as number[],
    setLineDash(d: number[]) { this.dash = d; },
    getLineDash() { return this.dash; },
    clearRect(x: number, y: number, w: number, h: number) { calls.push(['clear', `${x},${y},${w},${h}`]); },
    stroke() { calls.push(['stroke', `${this.strokeStyle}|${this.dash.join()}|${this.lineDashOffset}|${this.lineWidth}`]); },
    beginPath() { calls.push(['begin', '']); },
    rect(x: number, y: number, w: number, h: number) { calls.push(['rect', `${x},${y},${w},${h}`]); },
  };
}
const as2d = (c: ReturnType<typeof fakeCtx>) => c as unknown as CanvasRenderingContext2D;
{
  const ctx = fakeCtx();
  drawAnts(as2d(ctx), [{ x: 0, y: 0, w: 1, h: 1, color: '#4cc2ff' }, { x: 2, y: 0, w: 1, h: 1, color: '#ffb000' }, { x: 4, y: 0, w: 1, h: 1, color: '#4cc2ff' }], 200, 100, 8, 4, 2, 3);
  const strokes = ctx.calls.filter((c) => c[0] === 'stroke').map((c) => c[1]);
  check(ctx.calls[0][0] === 'clear' && ctx.calls[0][1] === '0,0,200,100', 'the overlay cleared');
  check(strokes.join(' / ') === `${ANTS_DARK}||0|2 / #4cc2ff|8,8|-6|2 / ${ANTS_DARK}||0|2 / #ffb000|8,8|-6|2`, `per colour one path, the dark tone then the colour's dashes over it, in device pixels (${strokes.join(' / ')})`);
  check(ctx.calls.filter((c) => c[0] === 'rect').length === 3, 'every mark');
  check(ctx.dash.length === 0 && ctx.lineDashOffset === 0, 'the line dash put back');
  const none = fakeCtx();
  drawAnts(as2d(none), [], 200, 100, 8, 4, 2, 0);
  check(none.calls.length === 1 && none.calls[0][0] === 'clear', 'no marks: only cleared');
}
{
  const p = antsPhase(320), ctx = fakeCtx();
  drawAnts(as2d(ctx), [{ x: 0, y: 0, w: 1, h: 1, color: '#fff' }], 10, 10, 1, 1, 1.25, p);
  check(ctx.calls.some((c) => c[0] === 'stroke' && c[1] === `#fff|5,5|${-Math.round(p * 5 / 4)}|2`), 'at 1.25: dashes and offset in whole device pixels');
}

// the ticker (fake canvases: an overlay's)
function fakeCanvas() { return { isConnected: true, visible: true, checkVisibility() { return this.visible; } }; }
const asEl = (c: ReturnType<typeof fakeCanvas>) => c as unknown as HTMLCanvasElement;
const drawn = (c: ReturnType<typeof fakeCanvas>) => antsDrawn(asEl(c));
{
  const a = fakeCanvas(), b = fakeCanvas(), c = fakeCanvas();
  let na = 0, nb = 0;
  const offA = onAntsTick(asEl(a), () => { na++; drawn(a); });
  onAntsTick(asEl(b), () => { nb++; });
  // c is not registered: it may tell, nothing repaints it
  drawn(c);
  await wait(250);
  check(na === 0 && nb === 0, 'no running outline drawn: no repaint');
  drawn(a);
  drawn(b);
  await wait(350);
  check(na >= 2 && na <= 5, `a canvas drawing ants on every repaint: repainted on each tick (${na})`);
  check(nb === 1, `a canvas no longer drawing them: repainted once, then no more (${nb})`);
  a.visible = false;
  await wait(150);
  const before = na;
  await wait(250);
  check(na === before, 'hidden: not repainted');
  a.visible = true;
  drawn(a);
  await wait(150);
  check(na > before, 'shown and drawn again: it runs again');
  // the switch off: the dashes stand still, no ticks, but one repaint to show them standing
  const item = antsMenuItem();
  check(item.label === 'Animate selection outlines' && item.checked(), 'the View menu\'s switch, on');
  const nOff = na, nbOff = nb;
  void item.onToggle(false);
  check(!animateAnts.get() && !item.checked(), 'switched off');
  check(na === nOff + 1 && nb === nbOff + 1, 'switched off: every registered canvas shown repainted once');
  await wait(250);
  check(na === nOff + 1, 'off: no ticks');
  animateAnts.set(true);
  await wait(250);
  check(na > nOff + 2, 'on again: running');
  offA();
  await wait(150);
  const nGone = na;
  await wait(250);
  check(na === nGone, 'a canvas taken off: no more repaints');
}

// a sheet scrolled out of its panel or hidden, and back
{
  const s = fakeCanvas();
  let n = 0;
  onAntsTick(asEl(s), () => { n++; drawn(s); });
  onScreen(s, true);
  drawn(s);
  await wait(250);
  check(n >= 1, 'on the screen: running');
  onScreen(s, false);
  await wait(150);
  const k = n;
  await wait(300);
  check(n === k, 'scrolled out of its panel (or its panel hidden): not repainted');
  onScreen(s, true);
  await wait(250);
  check(n > k, 'back on the screen: running again by itself');
  onScreen(s, false);
  await wait(150);
  const j = n;
  animateAnts.set(false);
  check(n === j, 'the switch changed: a sheet off the screen not repainted');
  onScreen(s, true);
  check(n === j + 1, '... but once it is back on it');
  animateAnts.set(true);
}

// the overlay (a fake page: devicePixelRatio 2, a sheet of 384×192 canvas pixels shown at 150.25×75.25 CSS pixels)
{
  type El = { className: string; style: Record<string, string>; children: unknown[]; width: number; height: number; isConnected: boolean; append: (...c: unknown[]) => void; getContext: () => ReturnType<typeof fakeCtx>; getBoundingClientRect: () => { left: number; top: number; width: number; height: number }; checkVisibility: () => boolean };
  const ctxs: ReturnType<typeof fakeCtx>[] = [];
  const el = (): El => {
    const ctx = fakeCtx();
    ctxs.push(ctx);
    return {
      className: '', style: {}, children: [], width: 300, height: 150, isConnected: true,
      append(...c: unknown[]) { this.children.push(...c); },
      getContext: () => ctx,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 150.25, height: 75.25 }),
      checkVisibility: () => true,
    };
  };
  (globalThis as { document?: unknown }).document = { createElement: el };
  (globalThis as { devicePixelRatio?: number }).devicePixelRatio = 2;
  const sheet = el();
  sheet.width = 384; sheet.height = 192;
  let sheetPaints = 0;
  sheet.getContext = () => { sheetPaints++; return fakeCtx(); };
  const ov = new AntsOverlay(sheet as unknown as HTMLCanvasElement, () => ({ w: 16, h: 8 }));
  const root = ov.root as unknown as El, over = root.children[1] as El;
  check(root.className === 'ants-host' && root.children[0] === sheet && over.className === 'ants-over', 'the sheet and its overlay stacked in one box, which goes onto the page');
  ov.layout();
  check(over.width === 301 && over.height === 151 && over.style.width === '150.25px' && over.style.height === '75.25px', `the overlay the sheet's box in device pixels (${over.width}×${over.height})`);
  sheet.getBoundingClientRect = () => ({ left: 10.3, top: 20.2, width: 150.25, height: 75.25 });
  ov.layout();
  check(over.style.transform === 'translate(0.5px, 0px)', `the overlay started on a whole device pixel where the sheet's box is not (${over.style.transform})`);
  ov.layout({ W: 300, H: 150 });
  check(over.width === 300 && over.height === 150, 'the device pixels the ResizeObserver tells taken');
  const octx = over.getContext();
  octx.calls.length = 0;
  ov.set([{ x: 1, y: 2, w: 3, h: 1, color: '#4cc2ff' }]);
  const r = octx.calls.find((c) => c[0] === 'rect')?.[1];
  check(r === `${19 + 1},${38 + 1},${75 - 19 - 2},${56 - 38 - 2}`, `the mark in device pixels, from the sheet's cells (${r})`);
  check(octx.calls.some((c) => c[0] === 'stroke' && c[1].startsWith('#4cc2ff|8,8|')), 'its dashes of 4 screen pixels');
  octx.calls.length = 0;
  await wait(250);
  check(octx.calls.filter((c) => c[0] === 'rect').length >= 1, 'running: the overlay redrawn on the ticks');
  check(sheetPaints === 0, '... never the sheet');
  animateAnts.set(false);
  octx.calls.length = 0;
  ov.set([{ x: 1, y: 2, w: 3, h: 1, color: '#4cc2ff' }]);
  check(octx.calls.some((c) => c[0] === 'stroke' && c[1] === '#4cc2ff|8,8|0|2'), 'off: the dashes at phase 0, two-coloured');
  await wait(50);
  octx.calls.length = 0;
  await wait(250);
  check(octx.calls.length === 0, 'off: no ticks');
  animateAnts.set(true);
  ov.set([]);
  await wait(150);
  octx.calls.length = 0;
  await wait(250);
  check(octx.calls.length === 0, 'no marks: no ticks');
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
process.exit(0);
