// The event progress as a set of passed events (#425, eventset.ts): any set, applied in number order as the game does
// when it loads a save. A set that isn't a prefix: the overworld loaded at it is the game's after loading a save file
// with exactly those event bits (the test's own knowledge of the file: as testeventprogress), the map built from the
// event data (layer1AtProgress, layer2AtProgress) is that map, its save is learned by emulation (owprogress.ts
// progressSaveJob: the set's events' levels left in number order, the others not) and the search over the map built
// from the events with that save finds what it finds over the emulated map; test play starts with exactly its events.
// A prefix given as a set is the same progress as its count: the same key, the loads' and the saves' cache hits.
// node tools/testeventset.ts
import { Rom } from '../src/core/rom.ts';
import { Snes } from '../src/core/snes.ts';
import { OverworldEmulator, OverworldLoads, gameL1, gameL2, readL2, loadKey, OW_EVENTS, FLAG, type OwRender } from '../src/core/overworld.ts';
import {
  eventBits, eventSetOf, isPassed, withEvent, missingBefore, passedEvents, prefixLength, progressKey, sameProgress, canonicalProgress, progressWords,
} from '../src/core/eventset.ts';
import { layer1AtProgress } from '../src/core/owcellhistory.ts';
import { readEvents, layer2AtProgress, applyEvents, eventRunners } from '../src/core/owevents.ts';
import { progressSaves, progressSaveJob, progressMapFromEvents, progressMapsFromEvents, type ProgressSave } from '../src/core/owprogress.ts';
import { reach, reachInput } from '../src/core/owreach.ts';
import { readStart } from '../src/core/owsprites.ts';
import { shownMaps } from '../src/core/owstroke.ts';
import type { Job } from '../src/core/jobrunner.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { editorImage, pathKinds, pathShapes } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const run = <T>(job: Job<T>): T => { for (;;) { const r = job.next(); if (r.done) return r.value; } };

// ---- the set ----
const S = eventSetOf([1, 3, 9]);
check(same(S.subarray(0, 2), [0x50, 0x40]) && passedEvents(S).join() === '1,3,9' && isPassed(S, 3) && !isPassed(S, 0) && !isPassed(S, 2), 'events 01, 03, 09: bits $40, $10 of byte 0, $40 of byte 1');
check(prefixLength(S) === -1 && prefixLength(eventSetOf([0, 1, 2])) === 3 && prefixLength(eventSetOf([])) === 0 && prefixLength(eventBits(OW_EVENTS)) === OW_EVENTS, 'a prefix told from another set');
check(progressKey(eventSetOf([0, 1, 2])) === progressKey(3) && sameProgress(eventBits(5), 5) && !sameProgress(S, 10) && progressKey(S) !== progressKey(eventSetOf([1, 3])),
  'a prefix as a set has its count\'s key, other sets their own');
check(canonicalProgress(eventSetOf([0, 1])) === 2 && canonicalProgress(S) instanceof Uint8Array && same(eventBits(S), S), 'kept and asked for: a prefix as its count');
check(progressWords(0) === 'before events' && progressWords(0x0d) === 'after event 0C' && progressWords(OW_EVENTS) === 'with every event passed' && progressWords(S) === 'with events 01, 03, 09' && progressWords(eventSetOf([1, 3, 5, 7, 9])) === 'with 5 of 78 events', `in words: ${progressWords(S)}`);

const rom = new Rom(await editorImage());
const runners = eventRunners(rom), tlOf = (e: number) => runners.get(e)![0].tl;

// the overworld after loading save file A with the event bits `bits`, Mario on submap `map`
function fromSave(bits: Uint8Array, map: number): OwRender {
  const s = new Snes(rom.data), w = s.wram;
  s.reset();
  for (let f = 0; w[RAM.gameMode] !== GM.title && f < 2000; f++) s.runFrame();
  const file = new Uint8Array(0x8d), events = RAM.owEvents - RAM.levelFlags; // the file starts with $1EA2
  file.set(bits, events);
  file[RAM.submap - RAM.levelFlags] = map;
  const sum = (0x5a5a - file.reduce((a, v) => a + v, 0)) & 0xffff;
  s.sram.set(file, 0);
  s.sram[0x8d] = sum & 0xff; s.sram[0x8e] = sum >> 8;
  for (let f = 0; w[RAM.gameMode] !== GM.overworld && f < 1500; f++) {
    s.joy1 = (f % 16) < 4 ? (w[RAM.gameMode] === GM.title ? 0x1000 : 0x0080) : 0;
    s.runFrame();
  }
  s.joy1 = 0;
  for (let i = 0; i < 3; i++) s.runFrame();
  return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: w.slice(), ppuRegs: s.ppuRegs.slice(), ok: w[RAM.gameMode] === GM.overworld };
}

// ---- the map at the set: emulated, from the event data ----
const emu = new OverworldEmulator(rom), d = readEvents(rom);
const at3 = emu.load(1, 3);
for (const map of [0, 1]) {
  const r = emu.load(map, S), save = fromSave(S, map);
  check(r.ok && save.ok && same(r.wram.subarray(RAM.owEvents, RAM.owEvents + 15), S), `map ${map}: loaded with exactly the set's event bits`);
  check(same(gameL1(r), gameL1(save)) && same(gameL2(r), gameL2(save)), `map ${map}: layers 1 and 2 as after loading a save with events 01, 03, 09 passed`);
}
{
  const r = emu.load(1, S), l1 = layer1AtProgress(rom, S, d), l2 = layer2AtProgress(readL2(rom), d, S);
  check(same(l1, gameL1(r)), 'layer 1 built from the event data: the emulated one');
  check(same(l2.subarray(0x1000, 0x2000), gameL2(r)), 'layer 2 built from the event data: the emulated one (submaps)');
  check(!same(gameL1(r), gameL1(at3)) || !same(gameL2(r), gameL2(at3)), 'another map than the prefix up to event 02 shows');
  check([0, 4, 0x20, OW_EVENTS].every((n) => same(layer1AtProgress(rom, eventBits(n), d), layer1AtProgress(rom, n, d)) && same(layer2AtProgress(readL2(rom), d, n), applyEvents(readL2(rom), d, 0, n))),
    'a prefix: the same maps as by its count');
}

// ---- the loads: a prefix as a set is a cache hit ----
{
  const loads = new OverworldLoads(new OverworldEmulator(rom), 4);
  const a = loads.get(0, 2), b = loads.get(0, eventSetOf([0, 1])), c = loads.get(0, S);
  check(loadKey(0, eventSetOf([0, 1])) === loadKey(0, 2) && a === b, 'map 0 with events 00, 01 as a set: the load kept for progress 2');
  check(c !== a && same(c.wram.subarray(RAM.owEvents, RAM.owEvents + 15), S) && loads.get(0, eventSetOf([1, 3, 9])) === c, 'the set\'s own load, kept for it');
}

// ---- the save of the set, learned by emulation ----
const loads = new OverworldLoads(new OverworldEmulator(rom), 4);
const saves = progressSaves(loads);
const save = run(progressSaveJob(loads, S)) as ProgressSave;
{
  const passed = (s: ProgressSave, e: number) => (s.levelFlags[tlOf(e)] & FLAG.passed) !== 0;
  check([1, 3, 9].every((e) => passed(save, e)) && ![0, 2, 4, 5, 8].some((e) => passed(save, e)),
    `the levels running events 01, 03, 09 passed (translevels ${[1, 3, 9].map((e) => hx(tlOf(e))).join(', ')}), not those of 00, 02, 04, 05, 08`);
  check(save.eventsTriggered === saves[0].eventsTriggered + 3, `three events counted (${save.eventsTriggered})`);
  check([1, 3, 9].every((e) => save.levelFlags[tlOf(e)] === saves[e + 1].levelFlags[tlOf(e)]),
    'each of its levels with the flags it has once left at the prefix up to its event');
  check(run(progressSaveJob(loads, eventSetOf(Array.from({ length: 0x10 }, (_, e) => e)))) === saves[0x10] && run(progressSaveJob(loads, 0x10)) === saves[0x10],
    'a prefix as a set: the save of every prefix learned once (the same object)');
  check(run(progressSaveJob(loads, eventSetOf([1, 3, 9]))) === save, 'the set\'s save kept for it');
}

// ---- reach at the set: over the map built from the events, as over the emulated one ----
{
  const kinds = pathKinds(rom), shapes = pathShapes(rom), start = readStart(rom, 0);
  const built = progressMapFromEvents(rom, S, save.levelFlags);
  const r = new OverworldEmulator(rom).load(0, S);
  const a = reach(reachInput(rom, built.l1, built.tls, built.flags, kinds, shapes, start));
  const b = reach(reachInput(rom, gameL1(r), r.wram.subarray(RAM.owTranslevels, RAM.owTranslevelsEnd), save.levelFlags, kinds, shapes, start));
  const n = a.tiles.reduce((x: number, v) => x + (v ? 1 : 0), 0);
  check(same(a.tiles, b.tiles) && n > 0, `the same ${n} tiles reached over the map built from the events and the emulated one`);
  const at3r = reach(reachInput(rom, progressMapsFromEvents(rom, saves.map((s) => s.levelFlags))[3].l1, built.tls, saves[3].levelFlags, kinds, shapes, start));
  check(!same(a.tiles, at3r.tiles), 'other tiles reached than at the prefix up to event 02');
  const p4 = progressMapFromEvents(rom, 4, saves[4].levelFlags), m4 = progressMapsFromEvents(rom, saves.map((s) => s.levelFlags))[4];
  check(same(p4.l1, m4.l1) && same(p4.flags, m4.flags), 'a prefix: the map of progressMapsFromEvents');
}

// ---- the event list's checks and the edited event (#426) ----
{
  check(passedEvents(withEvent(S, 0)).join() === '0,1,3,9' && passedEvents(withEvent(S, 3, false)).join() === '1,9' && prefixLength(withEvent(eventSetOf([0, 1]), 2)) === 3,
    'an event checked or unchecked');
  check(missingBefore(S, 9).join() === '0,2,4,5,6,7,8' && !missingBefore(eventSetOf([0, 1, 2, 7]), 3).length && missingBefore(eventSetOf([]), 0).length === 0,
    'the events below the edited one not checked (where the map shown differs from the one it is stored against)');
  // the maps shown while event 09 is edited: at its base (events 00–08 checked) both layers as after it; with the set
  // {01, 03} checked the map at {01, 03, 09} with the tiles painted into the event over it
  const r = new OverworldEmulator(rom), base = r.load(1, 10), other = r.load(1, withEvent(S, 9));
  const maps = { l1: readL2(rom).slice(0, 0x800), l2: readL2(rom) }, from = { l1: maps.l1.slice(), l2: maps.l2.slice() };
  const after = applyEvents(readL2(rom), d, 0, 10), synced = after.slice(), l1 = gameL1(base), was = l1.slice();
  const cell = 0x400 + 5, l2cell = 0x1000 + 7;
  l1[cell] = 0x7f; after[l2cell] = 0x1234; // (painted into the event)
  const ev = { after, synced, l1, game: was };
  const atBase = shownMaps({ l1: gameL1(base), l2: gameL2(base) }, 1, maps, from, { ...ev, atBase: true });
  check(atBase.l1 === l1 && atBase.l2 === after, 'at the edited event\'s base: its maps as painted');
  const shown = shownMaps({ l1: gameL1(other), l2: gameL2(other) }, 1, maps, from, { ...ev, atBase: false });
  const g1 = gameL1(other), g2 = gameL2(other);
  check(shown.l1[cell] === 0x7f && shown.l2[l2cell] === 0x1234, 'at another set: the tiles painted into the event shown');
  check(shown.l1.every((t, i) => i === cell || t === g1[i]) && [...shown.l2.subarray(0x1000, 0x2000)].every((t, k) => k === 7 || t === g2[k]),
    'the other tiles as the game shows the set (the checked events and the edited one)');
}

// ---- test play with the set ----
{
  const le = new LevelEmulator(rom);
  const p = PlaySession.fromOverworld(le, -1, S, save), w = le.snes.wram;
  check(p.mode === GM.overworld && same(w.subarray(RAM.owEvents, RAM.owEvents + 15), S) && same(w.subarray(RAM.levelFlags, RAM.levelFlags + 0x60), save.levelFlags),
    'test play: a game with exactly the set\'s events and its save');
  p.close();
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
