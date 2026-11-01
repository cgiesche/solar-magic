// The level view's overlays drawn for a level other than the open one (ui/leveloverlays.ts, as Levels as images
// draws them): from that level's load and entrances, with probes in that level's tileset – collision and entrance
// markers checked on a recording canvas; what an image waits for (overlayPending).
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, serializeLevelSprites, type Level } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { renderLevelImages } from '../src/core/levelimage.ts';
import { BlockProber, collisionIn } from '../src/core/blockprobe.ts';
import { entrancesInto } from '../src/core/exitgraph.ts';
import { entranceMarkers } from '../src/core/entrances.ts';
import { map16Tile } from '../src/core/ram.ts';
import { hex3 } from '../src/core/names.ts';
import { levelOverlay, overlayPending, paintOverlays, wholeLevel } from '../src/ui/leveloverlays.ts';
import type { App } from '../src/ui/app.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// ---- a canvas that records what is drawn ----
type Seg = [number, number, number, number];
class RecPath { segs: Seg[] = []; private at: [number, number] = [0, 0]; moveTo(x: number, y: number) { this.at = [x, y]; } lineTo(x: number, y: number) { this.segs.push([...this.at, x, y]); this.at = [x, y]; } closePath() {} rect() {} arc() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D = RecPath;
interface Call { op: string; args: unknown[]; style: { fill: unknown; stroke: unknown } }
function recCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, font: '', lineCap: 'butt' };
  const ctx = new Proxy(state, {
    get: (t, k: string) => k in t ? t[k] : k === 'measureText' ? (s: string) => ({ width: s.length * 6 })
      : (...args: unknown[]) => { calls.push({ op: k, args, style: { fill: t.fillStyle, stroke: t.strokeStyle } }); },
    set: (t, k: string, v) => { t[k] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
const open = loadLevel(rom, 0x105); // the open level: tileset 7
const lv = loadLevel(rom, 0x106); // another level: tileset 0, the secondary entrance 1CA into it
check(open.header.tileset !== lv.header.tileset, `level 106's tileset (${lv.header.tileset}) is not the open level's (${open.header.tileset})`);
const r = renderLevelImages(rom, emu, lv, { ...levelOverride(rom, lv), sprites: serializeLevelSprites(rom, lv) });
if ('error' in r) throw new Error(r.error);

// the App the overlays ask: its probes in a tileset (as ProbeClient's blockIn/collisionIn/spriteIn), its markers
const prober = new BlockProber(rom, emu);
const asked = new Set<number>(); // the tilesets probes were asked in
let known = true; // probes known (else: undefined, still asked for)
const inTs = <T>(ts: number, f: () => T): T | undefined => { asked.add(ts); if (!known) return undefined; prober.use(ts); return f(); };
const app = {
  rom, level: open, gameView: null, gameViewMario: null, cdm16: new Set<number>(),
  markers: (l: Level) => entranceMarkers(rom, l, entrancesInto(rom, l.number)),
  viewSwitches: () => [],
  probes: {
    blockIn: (t: number, ts: number) => inTs(ts, () => prober.probe(t)),
    collisionIn: (t: number, ts: number) => inTs(ts, () => prober.probeCollision(t)),
    spriteIn: (n: number, ts: number) => inTs(ts, () => prober.probeSprite(n)),
    cameraBands: () => null,
  },
} as unknown as App;
const show: App['show'] = { layer1: true, layer2: true, layer3: true, sprites: false, grid: false, screens: false, exits: false, ghost: true, anim: true, items: false, invisible: false, deaths: false, collision: true, preview: false, arcs: false, gameView: false, scrollBands: false };

const src = levelOverlay(app, lv, r.render, r.images, () => undefined, undefined);

// what an image waits for: the collision of every tile of the level, in its tileset
known = false;
const pending = overlayPending(src, show);
check(pending > 0, `collision shown, probes unknown: the image waits for ${pending}`);
check(overlayPending(src, { ...show, collision: false }) === 0, 'collision and items hidden: it waits for nothing');
known = true;
check(overlayPending(src, show) === 0, 'probes known: it waits for nothing');
check(asked.size === 1 && asked.has(lv.header.tileset), `probes asked in level 106's tileset only: ${[...asked].join(',')}`);

// ---- drawn ----
const { ctx, calls } = recCtx();
const im = r.images, g = im.geom1;
paintOverlays(ctx, app, src, {
  show, lw: 1, px: 1, area: wholeLevel(g), width: im.width, height: im.height, screens: lv.header.screens,
  exits: false, chosenExit: -1, layer2: false, tideLabelX: 8, spriteAlpha: 1, sprites: { image: () => undefined, imageAlpha: 1, active: false, selected: () => false, incomplete: new Set() },
});

// collision: the level dimmed, the solid tops of its ground as white lines, at the tiles level 106's load put there
{
  const dim = calls.find((c) => c.op === 'fillRect' && c.style.fill === 'rgba(0,0,0,0.45)');
  check(!!dim && dim.args.join() === `0,0,${im.width},${im.height}`, `the whole level dimmed: ${dim?.args.join()}`);
  const white = calls.filter((c) => c.op === 'stroke' && c.style.stroke === '#fff' && c.args[0] instanceof RecPath).flatMap((c) => (c.args[0] as RecPath).segs);
  const lines = new Set(white.map((s) => s.join()));
  // the tops expected: solid tiles (not platforms or slopes) with a tile above that doesn't close them off
  const coll = (x: number, y: number) => { const a = g.addr(x, y); return a < 0 ? undefined : collisionIn(prober.probeCollision(map16Tile(r.render.wram, a)), []); };
  let tops = 0, found = 0;
  for (let y = 1; y < g.height; y++) for (let x = 0; x < g.width; x++) {
    const c = coll(x, y);
    if (!c?.top || c.slope || !(c.bottom || c.left || c.right) || coll(x, y - 1)?.bottom) continue;
    tops++;
    if (lines.has([x * 16, y * 16, x * 16 + 16, y * 16].join())) found++;
  }
  check(tops > 20 && found === tops, `level 106's solid tops drawn: ${found} of ${tops} (${white.length} white lines)`);
}

// entrance markers: level 106's main entrance, midway point and secondary entrance 1CA, where its header puts them
{
  const marks = entranceMarkers(rom, lv, entrancesInto(rom, lv.number)), openMarks = entranceMarkers(rom, open, entrancesInto(rom, open.number));
  const text = (t: string, x: number, y: number) => calls.some((c) => c.op === 'fillText' && c.args[0] === t && c.args[1] === x && c.args[2] === y);
  const main = marks.find((m) => m.kind === 'main')!, mid = marks.find((m) => m.kind === 'midway')!, sec = marks.find((m) => m.kind === 'sec');
  check(text('M', main.x + 5, main.y + 27.5), `main entrance at ${main.x},${main.y}`);
  check(text('Z', mid.x + 5, mid.y + 27.5), `midway point at ${mid.x},${mid.y}`);
  check(sec?.index === 0x1ca && text('S', sec.x + 5, sec.y + 27.5) && text(hex3(0x1ca), sec.x + 15, sec.y + 27.5), `secondary entrance 1CA at ${sec?.x},${sec?.y}`);
  check(!openMarks.some((m) => m.kind === 'sec' && text(hex3(m.index), m.x + 15, m.y + 27.5)), 'not the open level\'s secondary entrances');
}

// the same level with the View's collision off: no collision drawn, the markers still are
{
  const { ctx: c2, calls: k2 } = recCtx();
  paintOverlays(c2, app, src, {
    show: { ...show, collision: false }, lw: 1, px: 1, area: wholeLevel(g), width: im.width, height: im.height, screens: lv.header.screens,
    exits: false, chosenExit: -1, layer2: false, tideLabelX: 8, spriteAlpha: 1, sprites: { image: () => undefined, imageAlpha: 1, active: false, selected: () => false, incomplete: new Set() },
  });
  check(!k2.some((c) => c.style.fill === 'rgba(0,0,0,0.45)' && c.op === 'fillRect'), 'collision off: not drawn');
  check(k2.some((c) => c.op === 'fillText' && c.args[0] === 'M'), 'collision off: the markers drawn');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
