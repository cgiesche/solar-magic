// The overworld map's animation (#420, core/owanimsteps.ts): the steps of a submap at an event progress, emulated
// (the load run on, steps of ANIM_STEP_FRAMES frames) until they repeat, and drawn on the map's layers and the
// pickers' pictures from the editor's own tilemaps (OwTileAnimation).
// - the steps are the game's: step k's 8x8 tiles and colors as the load run on (k+1) steps; they repeat after the
//   period found (animPeriod: checked on its own too)
// - the game's water animates on every submap; a step redraws on the map only the cells it changes
// - a picture of layer 1 tiles and of layer 2 entries (a sheet) redrawn for a step: as drawn whole with the step's
//   graphics, untouched cells kept; a checkerboard back where a tile draws none
// - the job yields its progress ("Animations n/m"); a tilemap edit keeps the steps (they hold)
// - in the probe worker: learned as found directly
// - View → "Animation" (motion.ts animationPref): on by default, off by default under prefers-reduced-motion
// node tools/testowanimsteps.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, owCharBase, owTileCaches, owTileWords, drawOwMap, readL2, writeL2, readL1, writeL1, l1Index, l2Index, type OwRender } from '../src/core/overworld.ts';
import { owAnimStepsJob, animPeriod, OwTileAnimation, ANIM_STEP_FRAMES, MAX_ANIM_STEPS } from '../src/core/owanimsteps.ts';
import { drawMap16, blit8, type AnimStep, type TilePixels } from '../src/core/render.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { ProbeClient } from '../src/core/probeclient.ts';
import type { ProbeMessage, ProbeReply } from '../src/core/probeprotocol.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { loadLevel, L2_PTRS } from '../src/core/level.ts';
import { setPrefStorage } from '../src/ui/prefs.ts';
import { animationPref } from '../src/ui/motion.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const rom = new Rom((await editorImage()).slice());
const loads = new OverworldLoads(new OverworldEmulator(rom), 4);

// ---- animPeriod ----
check(animPeriod([1, 2, 3, 1, 2, 3, 1]) === 3, 'period: 1 2 3 1 2 3 1 repeats after 3');
check(animPeriod([5, 5, 5, 5]) === 1, 'period: all the same, 1');
check(animPeriod([1, 1, 2, 1, 1, 1]) === 6, 'period: a step that comes once (a lightning), all of them');
check(animPeriod([1, 2, 1, 3, 1, 2, 1, 3]) === 4, 'period: a step back as the first doesn\'t end it early (4, not 2)');

// the 8x8 tiles of layers 1 and 2 and their colors of a step: the same as another's
const bgSame = (r: OwRender, a: AnimStep, b: AnimStep) => {
  for (const base of [owCharBase(r, 1), owCharBase(r, 2)]) for (let i = 0; i < 0x8000; i++) if (a.vram[(base + i) & 0xffff] !== b.vram[(base + i) & 0xffff]) return false;
  for (let i = 0; i < 256; i++) if (a.cgram[i] !== b.cgram[i]) return false;
  return true;
};
// the console after the load of `map` run on `n` steps: each step's VRAM and CGRAM
function runSteps(map: number, n: number): AnimStep[] {
  loads.restore(map, 0);
  const s = loads.emu.snes, out: AnimStep[] = [];
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < ANIM_STEP_FRAMES; f++) s.runFrame();
    out.push({ vram: s.vram.slice(), cgram: s.cgram.slice() });
  }
  return out;
}

// ---- the steps ----
const labels: string[] = [];
const yi = (() => {
  const job = owAnimStepsJob(loads, 1, 0);
  for (;;) { const r = job.next(); if (r.done) return r.value; if (r.value) labels.push(r.value); }
})();
const r1 = loads.get(1, 0);
check(yi.length > 1 && yi.length <= MAX_ANIM_STEPS, `Yoshi's Island: ${yi.length} steps`);
check(labels.length === MAX_ANIM_STEPS - 1 && labels[0] === `Animations 2/${MAX_ANIM_STEPS}` && labels.at(-1) === `Animations ${MAX_ANIM_STEPS}/${MAX_ANIM_STEPS}`,
  `the job's progress: ${labels[0]} … ${labels.at(-1)}`);
{
  const p = yi.length, ran = runSteps(1, 2 * p + 1);
  check(yi.every((s, k) => bgSame(r1, s, ran[k])), 'each step as the game run on to it');
  check(ran.slice(0, p + 1).every((s, k) => bgSame(r1, s, ran[k + p])), `the game repeats them after ${p} steps`);
  check(!bgSame(r1, ran[0], ran[1]) || p === 1, 'the steps differ (the water moves)');
}
check(runJob(owAnimStepsJob(loads, 1, 0)) === yi, 'asked again: kept');

// ---- on the map ----
const anim = new OwTileAnimation(rom, r1);
const moving = yi.find((s) => anim.stepChanges(s))!;
check(!!moving, 'a step changes what the map can show');
{
  const l2 = readL2(rom), l1 = readL1(rom), tcs = owTileCaches(r1);
  const base2 = drawOwMap(rom, r1, 1, undefined, l2, tcs), base1 = drawOwMap(rom, r1, 1, l1, undefined, tcs);
  const step2 = anim.stepLayer(base2, 2, 1, l2, moving), step1 = anim.stepLayer(base1, 1, 1, l1, moving);
  const r = { ...r1, vram: moving.vram, cgram: moving.cgram }, whole2 = drawOwMap(rom, r, 1, undefined, l2), whole1 = drawOwMap(rom, r, 1, l1, undefined);
  const same = (a: Uint32Array, b: Uint32Array) => a.every((v, i) => v === b[i]);
  check(!!step2 && same(step2, whole2), 'layer 2 at a step: as drawn whole with its graphics');
  check(same(step1 ?? base1, whole1), 'layer 1 at a step: as drawn whole with its graphics');
  // the cells it changes: water (8x8 tiles the game rewrites), not every cell
  let changed = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (anim.entryChanges(moving, 2, l2[l2Index(1, x, y)])) changed++;
  check(changed > 0 && changed < 64 * 64, `layer 2 cells the step redraws: ${changed} of ${64 * 64}`);
  check(!step2 || base2 !== step2, 'the still layer stays as it was (a copy is drawn)');
  const still = yi.find((s) => !anim.stepChanges(s));
  check(!still || anim.stepLayer(base2, 2, 1, l2, still) === null, 'a step changing nothing: no copy');
}

// ---- on the pickers' pictures ----
{
  // layer 2 entries, 4 a row, and layer 1 tiles 0–31, 8 a row, on a checkerboard
  const back = (x: number, y: number) => (((x >> 2) ^ (y >> 2)) & 1 ? 0xff2a2a2a : 0xff1c1c1c);
  const water = [...new Set(readL2(rom))].filter((v) => anim.entryChanges(moving, 2, v)).slice(0, 4), entries = [0, ...water];
  const draw = (r: Pick<OwRender, 'vram' | 'cgram' | 'ppuRegs' | 'wram' | 'ok'>, list: number[], l2: boolean, w: number) => {
    const size = l2 ? 8 : 16, W = w * size, H = Math.ceil(list.length / w) * size, px = new Uint32Array(W * H), tcs = owTileCaches(r as OwRender);
    list.forEach((v, i) => {
      if (l2) blit8(px, W, H, tcs.l2.get(v), (i % w) * 8, Math.floor(i / w) * 8);
      else drawMap16(px, W, H, tcs.l1, owTileWords(rom, v), (i % w) * 16, Math.floor(i / w) * 16);
    });
    for (let i = 0; i < px.length; i++) if (!px[i]) px[i] = back(i % W, Math.floor(i / W));
    return { px, w: W, h: H, cells: list.flatMap((v, i) => [(i % w) * size, Math.floor(i / w) * size, v]), bg: l2, back: 0, backAt: back } satisfies TilePixels;
  };
  const at = { ...r1, vram: moving.vram, cgram: moving.cgram };
  for (const [what, list, l2, w] of [['layer 2 entries', entries, true, 4], ['layer 1 tiles', Array.from({ length: 0x80 }, (_, t) => t), false, 8]] as const) {
    const p = draw(r1, [...list], l2, w), want = draw(at, [...list], l2, w);
    const drew = anim.redraw(p, null, moving);
    check(p.px.every((v, i) => v === want.px[i]), `${what} at a step: as drawn with its graphics (${drew ? 'some drawn anew' : 'none changed'})`);
    anim.redraw(p, moving, null);
    check(p.px.every((v, i) => v === draw(r1, [...list], l2, w).px[i]), `${what}: back to the still picture`);
  }
  check(water.length > 0, `water entries in the layer 2 sheet: ${water.map((v) => v.toString(16)).join(' ')}`);
}

// ---- what the steps depend on ----
{
  const l1 = readL1(rom), l2 = readL2(rom);
  const t = l1[l1Index(1, 3, 3)];
  l1[l1Index(1, 3, 3)] = t ^ 1;
  writeL1(rom, l1);
  const e = l2[l2Index(1, 5, 5)];
  l2[l2Index(1, 5, 5)] = e ^ 1;
  writeL2(rom, l2);
  check(runJob(owAnimStepsJob(loads, 1, 0)) === yi, 'the tilemaps painted: the steps hold');
}

// ---- every map ----
{
  const counts = Array.from({ length: 7 }, (_, m) => runJob(owAnimStepsJob(loads, m, 0)).length);
  check(counts.every((n) => n > 1), `every map animates (steps: ${counts.join(' ')}; Valley of Bowser's lightning comes at random: all ${MAX_ANIM_STEPS})`);
}

// ---- in the probe worker ----
{
  const host = new ProbeHost(), er = new Rom((await editorImage()).slice());
  let reply!: (d: ProbeReply) => void;
  const client = new ProbeClient({
    results: new ResultCache(new RomFingerprint(er)), cacheReady: Promise.resolve(),
    rom: () => er, tileset: () => 0,
    connect: (r) => { reply = r; return (m: ProbeMessage) => host.handle(m); },
    later: () => {}, setBusy: () => {}, ready: () => {}, kindsReady: () => {},
    kindLevel: () => { const lv = loadLevel(er, 0x105); return { level: { number: lv.number, header: lv.header }, layer2Pointer: er.r24(L2_PTRS + 0x105 * 3) }; },
  });
  const run = async () => { await new Promise((r) => setTimeout(r, 0)); while (host.pending) { const d = host.next(); if (d) reply(d); } };
  let got: AnimStep[] | undefined;
  const ask = () => client.learn<AnimStep[]>('owas1:1', { kind: 'owAnimSteps', map: 1, progress: 0 }, { lane: 'owas', input: { progress: 0 }, replace: true, done: (v) => (got = v) });
  check(ask() === undefined, 'Yoshi\'s Island\'s steps: asked for');
  await run();
  check(!!got && got.length === yi.length && got.every((s, k) => bgSame(r1, s, yi[k])), `learned as found directly (${got?.length} steps)`);
  check(ask() === got, 'then known at once');
}

// ---- View → "Animation" ----
{
  setPrefStorage(null);
  const g = globalThis as { matchMedia?: (q: string) => { matches: boolean } };
  check(animationPref.get(), 'on by default');
  g.matchMedia = (q) => ({ matches: q.includes('prefers-reduced-motion') });
  check(!animationPref.get(), 'off by default when the system asks for reduced motion');
  animationPref.set(true);
  check(animationPref.get(), 'switched on there: kept');
  delete g.matchMedia;
  animationPref.reset();
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
