// Running selection outlines in dense picker sheets (ui/ants.ts): two-colour dashes of 4 screen pixels whatever the
// zoom, all in phase by one central ticker at 10 fps; a canvas repainted on a tick only while it showed a running
// outline and is visible, no ticks otherwise; the switch "Animate selection outlines" (off: the dashes stand still).
// node tools/testants.ts
import { setPrefStorage } from '../src/ui/prefs.ts';
import { antsDash, antsPhase, strokeAnts, antsRect, onAntsTick, animateAnts, antsMenuItem, ANTS_DARK, ANTS_PERIOD_MS } from '../src/ui/ants.ts';

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
  const d = antsDash(1, 3);
  check(d.dash.join() === '4,4' && d.offset === -3, 'at 1 unit a pixel: dashes of 4');
  const z = antsDash(0.25, 3);
  check(z.dash.join() === '1,1' && z.offset === -0.75, 'zoomed 4×: the dashes the same on the screen');
}

// a fake canvas and context
type Call = [string, string];
function fakeCanvas(clientWidth = 200, width = 400) {
  const calls: Call[] = [];
  const canvas = { width, clientWidth, isConnected: true, visible: true, checkVisibility() { return this.visible; } };
  const ctx = {
    canvas, calls, lineWidth: 2, strokeStyle: '', lineDashOffset: 0, dash: [] as number[], a: 2,
    getTransform() { return { a: this.a, b: 0 }; },
    setLineDash(d: number[]) { this.dash = d; },
    getLineDash() { return this.dash; },
    stroke() { calls.push(['stroke', `${this.strokeStyle}|${this.dash.join()}|${this.lineDashOffset}`]); },
    beginPath() { calls.push(['begin', '']); },
    rect(x: number, y: number, w: number, h: number) { calls.push(['rect', `${x},${y},${w},${h}`]); },
  };
  return ctx;
}
const as2d = (c: ReturnType<typeof fakeCanvas>) => c as unknown as CanvasRenderingContext2D;
const asEl = (c: ReturnType<typeof fakeCanvas>) => c.canvas as unknown as HTMLCanvasElement;

{
  const ctx = fakeCanvas(); // 400 canvas pixels on 200 CSS pixels, scaled 2×: a user unit is a CSS pixel
  strokeAnts(as2d(ctx), '#4cc2ff', 0);
  const strokes = ctx.calls.filter((c) => c[0] === 'stroke').map((c) => c[1]);
  check(strokes.length === 2 && strokes[0] === `${ANTS_DARK}||0` && strokes[1] === '#4cc2ff|4,4|0', `the path in the dark tone, then the colour's dashes over it (${strokes.join(' / ')})`);
  check(ctx.dash.length === 0 && ctx.lineDashOffset === 0, 'the line dash put back');
  check(ctx.lineWidth === 2, 'the line width unchanged');
  ctx.calls.length = 0;
  ctx.a = 8; // zoomed 4× more
  strokeAnts(as2d(ctx), '#4cc2ff', 2);
  check(ctx.calls.some((c) => c[0] === 'stroke' && c[1] === '#4cc2ff|1,1|-0.5'), 'zoomed in: dashes of 4 screen pixels still');
  ctx.calls.length = 0;
  antsRect(as2d(ctx), 1, 2, 3, 4, '#fff');
  check(ctx.calls[0][0] === 'begin' && ctx.calls[1][1] === '1,2,3,4' && ctx.calls.filter((c) => c[0] === 'stroke').length === 2, 'a rectangle');
}

// the ticker
{
  const a = fakeCanvas(), b = fakeCanvas(), c = fakeCanvas();
  let na = 0, nb = 0;
  const offA = onAntsTick(asEl(a), () => { na++; strokeAnts(as2d(a), '#fff'); });
  onAntsTick(asEl(b), () => { nb++; });
  // c is not registered: it may draw ants, nothing repaints it
  strokeAnts(as2d(c), '#fff');
  await wait(250);
  check(na === 0 && nb === 0, 'no running outline drawn: no repaint');
  strokeAnts(as2d(a), '#fff');
  strokeAnts(as2d(b), '#fff');
  await wait(350);
  check(na >= 2 && na <= 5, `a canvas drawing ants on every repaint: repainted on each tick (${na})`);
  check(nb === 1, `a canvas no longer drawing them: repainted once, then no more (${nb})`);
  a.canvas.visible = false;
  await wait(150);
  const before = na;
  await wait(250);
  check(na === before, 'hidden: not repainted');
  a.canvas.visible = true;
  strokeAnts(as2d(a), '#fff');
  await wait(150);
  check(na > before, 'shown and drawn again: it runs again');
  // the switch off: the dashes stand still, no ticks, but one repaint to show them standing
  const item = antsMenuItem();
  check(item.label === 'Animate selection outlines' && item.checked(), 'the View menu\'s switch, on');
  const nOff = na, nbOff = nb;
  void item.onToggle(false);
  check(!animateAnts.get() && !item.checked(), 'switched off');
  check(na === nOff + 1 && nb === nbOff + 1, 'switched off: every registered canvas shown repainted once');
  const still = fakeCanvas();
  strokeAnts(as2d(still), '#fff', 5);
  check(still.calls.some((x) => x[0] === 'stroke' && x[1] === '#fff|4,4|0'), 'off: the dashes at phase 0, two-coloured');
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
  onAntsTick(asEl(s), () => { n++; strokeAnts(as2d(s), '#fff'); });
  onScreen(s.canvas, true);
  strokeAnts(as2d(s), '#fff');
  await wait(250);
  check(n >= 1, 'on the screen: running');
  onScreen(s.canvas, false);
  await wait(150);
  const k = n;
  await wait(300);
  check(n === k, 'scrolled out of its panel (or its panel hidden): not repainted');
  onScreen(s.canvas, true);
  await wait(250);
  check(n > k, 'back on the screen: running again by itself');
  onScreen(s.canvas, false);
  await wait(150);
  const j = n;
  animateAnts.set(false);
  check(n === j, 'the switch changed: a sheet off the screen not repainted');
  onScreen(s.canvas, true);
  check(n === j + 1, '... but once it is back on it');
  animateAnts.set(true);
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
process.exit(0);
