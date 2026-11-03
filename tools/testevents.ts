// Layer 2 event steps (owevents.ts, Lunar Magic's formats): read from the clean game and from the editor's ROM (the
// patch moves them to Lunar Magic's places), applied in number order they give the layer 2 the game shows at every
// event progress (emulated); the patch changes no event's effect.
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, gameL2, readL2, OW_EVENTS } from '../src/core/overworld.ts';
import { readEvents, applyEvents, hasEventPatch, eventList, stepEvent, type EventData, type EventRunner } from '../src/core/owevents.ts';
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

// ---- the editor's "Map after" list: before events, then the events by the level exit running them ----
{
  const runners = new Map<number, EventRunner[]>([
    [5, [{ tl: 0x02, exit: 1, tile: 0 }]], // level 002 secret exit
    [3, [{ tl: 0x02, exit: 0, tile: 0 }]], // level 002 normal exit
    [9, [{ tl: 0x01, exit: 0, tile: 0 }]], // level 001
  ]);
  const list = eventList(runners);
  check(list.length === OW_EVENTS + 1 && list[0].event === -1 && list[0].label === 'Before events', 'the list: "Before events", then every event once');
  check(list.slice(1, 4).map((x) => x.event).join() === '9,3,5', 'events run by a level exit first, by level, then exit');
  check(list[4].event === 0 && list[5].event === 1 && list[6].event === 2 && list[7].event === 4, 'the others by number');
  check(list[1].label === 'Level 001 · normal exit (09)' && list[4].label === 'Event 00', `labels: ${list[1].label}, ${list[4].label}`);
  check(new Set(list.map((x) => x.event)).size === OW_EVENTS + 1, 'no event twice');
  check(stepEvent(-1, -1) === -1 && stepEvent(-1, 1) === 0 && stepEvent(0, -1) === -1 && stepEvent(5, 1) === 6, 'stepping: one event back/further in number order, -1 the map before events');
  check(stepEvent(OW_EVENTS - 1, 1) === OW_EVENTS - 1, 'stepping stops at the last event');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
