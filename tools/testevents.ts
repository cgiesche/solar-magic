// Layer 2 event steps (owevents.ts, Lunar Magic's formats): read from the clean game and from the editor's ROM (the
// patch moves them to Lunar Magic's places), applied in number order they give the layer 2 the game shows at every
// event progress (emulated); the patch changes no event's effect.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, gameL2, readL2, OW_EVENTS } from '../src/core/overworld.ts';
import { readEvents, applyEvents, hasEventPatch, playthroughStrip, eventRunners, stepEvent, type EventData, type EventRunner } from '../src/core/owevents.ts';
import { levelName } from '../src/core/levelnames.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const region = (l2: Uint16Array, r: number) => l2.subarray(r * 0x1000, r * 0x1000 + 0x1000);
const diff = (a: ArrayLike<number>, b: ArrayLike<number>) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

const clean = new Rom(cleanImage()), rom = new Rom(await editorImage());
const cd = readEvents(clean), pd = readEvents(rom);

// ---- reading ----
check(!hasEventPatch(clean) && hasEventPatch(rom), 'the clean game has its own silent events, the editor\'s ROM Lunar Magic\'s hook');
check(cd.storage.length === 0xd00 && cd.area6 === 0x900, `the clean game's storage: ${hx(cd.storage.length)} tiles, 6x6 below 900`);
check(cd.steps.flat().length === 0x173 && cd.silent.flat().length === 0x2c, `the clean game's steps: ${hx(cd.steps.flat().length)} standard, ${hx(cd.silent.flat().length)} silent`);

// ---- applied in number order: the game's layer 2 at every event progress ----
const progressMaps = (d: EventData, base: Uint16Array) => Array.from({ length: OW_EVENTS + 1 }, (_, n) => applyEvents(base, d, 0, n));
const cMaps = progressMaps(cd, readL2(clean)), pMaps = progressMaps(pd, readL2(rom));
const differ = cMaps.map((m, n) => diff(m, pMaps[n])).filter((v) => v);
check(!differ.length, 'the patched ROM\'s steps give the same layer 2 as the clean game\'s at every event progress (00–78)');

const emu = new OverworldEmulator(rom), cemu = new OverworldEmulator(clean);
const samples = [0, 1, 6, 0x0c, 0x15, 0x20, 0x33, 0x45, 0x5c, 0x6f, OW_EVENTS];
for (const n of samples) for (const r of [0, 1]) {
  const game = gameL2(emu.load(r ? 1 : 0, n)), d = diff(region(pMaps[n], r), game);
  check(!d, `editor's ROM, progress ${hx(n)}, region ${r}: layer 2 as the game shows it${d ? ` (${d} tiles differ)` : ''}`);
}
for (const n of [0, 0x20, 0x6f]) for (const r of [0, 1]) {
  const a = gameL2(emu.load(r ? 1 : 0, n)), b = gameL2(cemu.load(r ? 1 : 0, n)), d = diff(a, b);
  check(!d, `progress ${hx(n)}, region ${r}: the editor's ROM shows the clean game's layer 2${d ? ` (${d} tiles differ)` : ''}`);
}

// ---- the playthrough strip: before events, then every event in number order, labelled by the level exit running it ----
{
  const runners = new Map<number, EventRunner[]>([
    [5, [{ tl: 0x02, exit: 1, tile: 0 }, { tl: 0x07, exit: 0, tile: 0 }]], // level 002's secret exit (and level 007's normal one)
    [3, [{ tl: 0x02, exit: 0, tile: 0 }]], // level 002's normal exit
    [9, [{ tl: 0x01, exit: 2, tile: 0 }]], // level 001's secret exit 2
  ]);
  const strip = playthroughStrip(runners, (tl) => `Level ${tl}`);
  check(strip.length === OW_EVENTS + 1 && strip[0].event === -1 && strip[0].label === 'Before events', 'the strip: "Before events", then every event once');
  check(strip.slice(1).every((x, k) => x.event === k), 'in number order (the order the game applies them)');
  check(strip[4].label === 'Level 2 · normal exit' && strip[4].number === '03', `an event by the exit running it, the number apart: ${strip[4].label} (${strip[4].number})`);
  check(strip[6].label === 'Level 2 · secret exit' && strip[6].others.join() === 'Level 7 · normal exit', `the first exit running it, the others apart: ${strip[6].label}; ${strip[6].others}`);
  check(strip[10].label === 'Level 1 · secret exit 2', `secret exits 2 and 3 numbered: ${strip[10].label}`);
  check(strip[0x50].label === 'Event 4F (run by no level exit)' && strip[0x50].number === '', `an event no exit runs: ${strip[0x50].label}`);
  // the test ROM: labelled by the levels' names
  const real = playthroughStrip(eventRunners(rom), (tl) => levelName(rom, tl));
  const yi2 = real.filter((x) => /YOSHI'S ISLAND 2/i.test(x.label)).map((x) => `${x.label} (${x.number})`);
  check(yi2.length > 0 && yi2.every((l) => / · (normal|secret) exit \(\w\w\)$/.test(l)), `the test ROM's labels by level name: ${yi2.join(', ')}`);
  check(stepEvent(-1, -1) === -1 && stepEvent(-1, 1) === 0 && stepEvent(0, -1) === -1 && stepEvent(5, 1) === 6, 'stepping: one event back/further in number order, -1 the map before events');
  check(stepEvent(OW_EVENTS - 1, 1) === OW_EVENTS - 1, 'stepping stops at the last event');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
