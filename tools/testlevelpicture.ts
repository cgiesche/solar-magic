// What a level's image is drawn with (ui/levelpicture.ts, #258): a level other than the open one gets its level scan
// played (the camera's reach of the game view frame) and its sprite memory checked (the sprites drawn incompletely),
// each a learn job waited for, only when the overlays shown draw from them; the open level's image draws the jump
// arcs from the tile they are pinned to, once they are emulated, another level's none; a cancel ends the wait.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, serializeLevelSprites, isL1Vertical, type Level } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { renderLevelImages } from '../src/core/levelimage.ts';
import { levelScanJob, scanKey, type ScanLevel } from '../src/core/levelscan.ts';
import { spriteMemSpec, spriteMemCheckJob, usedSpriteMemory, lostSprites } from '../src/core/spritemem.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { entrancesInto } from '../src/core/exitgraph.ts';
import { entranceMarkers } from '../src/core/entrances.ts';
import type { LearnJob } from '../src/core/probeprotocol.ts';
import type { JumpArc } from '../src/core/jumparcs.ts';
import type { Shown } from '../src/core/viewsettings.ts';
import type { LevelImages } from '../src/core/render.ts';
import { levelPicture, cancelWait, type ExportWait } from '../src/ui/levelpicture.ts';
import { paintOverlays, wholeLevel } from '../src/ui/leveloverlays.ts';
import type { App } from '../src/ui/app.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
const open = loadLevel(rom, 0x105);
// another level: 00C with a lone sprite E0 sprite memory draws incompletely (as in testprobehost)
const lvc: Level = { ...loadLevel(rom, 0xc), sprites: [{ uid: 1, num: 0xe0, x: 8, y: 0x14, extra: 0 }] };
const ovOf = (lv: Level) => ({ ...levelOverride(rom, lv), sprites: serializeLevelSprites(rom, lv) });

// the App levelPicture asks: its learn jobs run at once (or never: hold), what it learned
const learnedKeys: string[] = [];
let hold = false;
let arcsAsked = 0;
const arcs: JumpArc[] = [{ speed: 'run', dir: 1, pts: [8, 8, 40, -20, 72, 8], end: 'land' }];
const listeners = new Map<string, (() => void)[]>();
let show: Shown = { layer1: true, layer2: true, layer3: true, sprites: false, grid: false, screens: false, exits: false, ghost: true, anim: true, items: false, invisible: false, deaths: false, collision: false, preview: false, arcs: false, gameView: false, scrollBands: false };
const app = {
  rom, level: open, view: { get show() { return show; }, gameView: null, gameViewMario: null, cdm16: new Set<number>() },
  markers: (l: Level) => entranceMarkers(rom, l, entrancesInto(rom, l.number)),
  viewSwitches: () => [],
  buildOverrides: ovOf,
  scanLevel: (lv: Level, ov: ReturnType<typeof ovOf>, im: Pick<LevelImages, 'width' | 'height'>): ScanLevel => ({ number: lv.number, ov, vertical: isL1Vertical(rom, lv.header.mode), width: im.width, height: im.height }),
  spriteMemCheck: (lv: Level) => spriteMemSpec(lv, usedSpriteMemory(rom)),
  spriteJobs: () => ({ all: { key: 'all', job: { kind: 'sprites' }, input: null } }),
  spriteVariant: () => null,
  spriteCanvas: () => undefined,
  jumpArcs: () => (++arcsAsked > 1 ? arcs : undefined),
  on: (ev: string, f: () => void) => { listeners.set(ev, [...(listeners.get(ev) ?? []), f]); return () => listeners.set(ev, (listeners.get(ev) ?? []).filter((g) => g !== f)); },
  probes: {
    learn: (key: string, job: LearnJob, opts: { done?: (r: unknown) => void }) => {
      learnedKeys.push(key);
      if (hold) return undefined;
      if (job.kind === 'scan') return runJob(levelScanJob(emu, job.level));
      if (job.kind === 'spriteMem') return runJob(spriteMemCheckJob(emu, job.level));
      if (job.kind === 'sprites') return [];
      opts.done?.(null);
      return undefined;
    },
    blockIn: () => null, collisionIn: () => null, spriteIn: () => null, cameraBands: () => null,
  },
} as unknown as App;
const wait = (): ExportWait => ({ lane: 'level-images', cancelled: false, wake: null });
const loadOf = (lv: Level) => {
  const r = renderLevelImages(rom, emu, lv, ovOf(lv));
  if ('error' in r) throw new Error(r.error);
  return r;
};

// nothing shown that draws from the scan or the check: neither is learned
{
  const r = loadOf(lvc);
  learnedKeys.length = 0;
  const p = await levelPicture(app, lvc, r.images, r.render, wait());
  check(!!p && learnedKeys.length === 0 && p.overlay.reach === undefined && p.incomplete.size === 0, `no game view, no sprites: no scan, no check (${learnedKeys.join()})`);
}

// the game view frame and the sprites shown: level 00C's scan and sprite memory check, learned for it
{
  show = { ...show, gameView: true, sprites: true };
  const r = loadOf(lvc);
  learnedKeys.length = 0;
  const p = await levelPicture(app, lvc, r.images, r.render, wait());
  const scanned = runJob(levelScanJob(emu, app.scanLevel(lvc, ovOf(lvc), r.images)));
  const sm = spriteMemSpec(lvc, usedSpriteMemory(rom));
  check(learnedKeys.includes(scanKey(0xc, ovOf(lvc))) && learnedKeys.includes(sm.key), `00C: its scan and its sprite memory check learned (${learnedKeys.join()})`);
  check(!!p && scanned.camera != null && JSON.stringify(p.overlay.reach) === JSON.stringify(scanned.camera), '00C: the game view frame darkened by its scan\'s camera reach');
  const lost = lostSprites(sm.level, runJob(spriteMemCheckJob(emu, sm.level)));
  check(!!p && lost.length === 1 && p.incomplete.has(1) && p.incomplete.size === 1, `00C: sprite E0 drawn incompletely (${[...p?.incomplete ?? []].join()})`);
  check(p?.arcs === undefined, '00C: no jump arcs (another level than the open one)');
}

// the open level with jump arcs pinned: drawn once emulated (the wait asked again on 'arcs')
{
  show = { ...show, gameView: false, sprites: false, arcs: true };
  const r = loadOf(open);
  arcsAsked = 0;
  setTimeout(() => { for (const f of listeners.get('arcs') ?? []) f(); }, 10);
  const p = await levelPicture(app, open, r.images, r.render, wait(), { tx: 3, ty: 20 });
  check(!!p && p.arcs?.tx === 3 && p.arcs.ty === 20 && p.arcs.pinned && p.arcs.arcs === arcs && arcsAsked >= 2, `105: the pinned arcs, waited for (asked ${arcsAsked} times)`);
  const none = await levelPicture(app, open, r.images, r.render, wait());
  check(!!none && none.arcs === undefined, '105: no arcs without a pinned tile');
  show = { ...show, arcs: false };
  const off = await levelPicture(app, open, r.images, r.render, wait(), { tx: 3, ty: 20 });
  check(!!off && off.arcs === undefined, '105: no arcs while the View hides them');

  // drawn: the tile marked as pinned, the arc to where Mario lands
  const calls: { op: string; args: unknown[]; fill: unknown }[] = [];
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000' };
  const ctx = new Proxy(state, {
    get: (t, k: string) => k in t ? t[k] : k === 'measureText' ? (s: string) => ({ width: s.length * 6 }) : (...args: unknown[]) => { calls.push({ op: k, args, fill: t.fillStyle }); },
    set: (t, k: string, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const im = r.images;
  paintOverlays(ctx, app, p!.overlay, {
    show: { ...show, arcs: true }, lw: 1, px: 1, area: wholeLevel(im.geom1), width: im.width, height: im.height, screens: open.header.screens,
    exits: false, chosenExit: -1, layer2: false, tideLabelX: 8, spriteAlpha: 1, arcs: p!.arcs,
    sprites: { image: () => undefined, imageAlpha: 1, active: false, selected: () => false, incomplete: new Set() },
  });
  check(calls.some((c) => c.op === 'fillRect' && c.fill === 'rgba(255,255,255,0.25)' && c.args.join() === '48,320,16,16'), 'the pinned tile marked');
  check(calls.some((c) => c.op === 'lineTo' && c.args.join() === '72,8') && calls.some((c) => c.op === 'arc' && c.args[0] === 72 && c.args[1] === 8), 'the arc drawn to where Mario lands');
}

// cancelled while the scan is learned: nothing drawn
{
  show = { ...show, gameView: true };
  const r = loadOf(lvc);
  hold = true;
  const w = wait();
  setTimeout(() => cancelWait(w), 10);
  const p = await levelPicture(app, lvc, r.images, r.render, w);
  hold = false;
  check(p === null, 'cancelled while its scan is learned: null');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
