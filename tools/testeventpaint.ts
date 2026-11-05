// Painting a layer 2 event (owevents.ts paintEvent, ADR 0005): the map after the event becomes its steps; a paint
// stroke on the event (owstroke.ts) is one ROM edit; layer 1 painted as after an event leaves level tiles alone (objects
// on top of layer 1, placed as such). Every
// clean game's event painted as it is (its own map after it) and written back leaves the layer 2 of every event
// progress as it was; a painted change is shown by the game – passing the level, the steps on its submap appear one
// after the other in their order (VRAM, frame by frame), those on another submap at once in the tilemap (silent);
// reordering the steps changes the order in the game. All by emulation. A star painted as after an event takes a
// translevel of its own (owstars.ts, #288), the map before events unchanged; a path painted over it there frees it.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, OverworldLoads, gameL1, gameL2, readL1, readL2, readMaps, readTranslevels, baseEvent, OW_EVENTS, l1XY, l2Index, initialFlags,
} from '../src/core/overworld.ts';
import { OverworldStroke, type OwEventMaps } from '../src/core/owstroke.ts';
import {
  readEvents, writeEvents, applyEvents, paintEvent, reorderSteps, eventRunners, eventTitle, submapViews, submapOf, eventPlace, pieceTiles,
  layer1Without, l2XY, STORAGE_MAX, type EventData,
} from '../src/core/owevents.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { editorImage, romDiff, levelTiles, pathKinds, pathShapes } from './fixture.ts';
import { STAR_TILE, starDirs } from '../src/core/owstars.ts';
import { dirFlags } from '../src/core/owroute.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const diff = (a: ArrayLike<number>, b: ArrayLike<number>) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
const progressMaps = (d: EventData, base: Uint16Array) => { const out = [base]; for (let e = 0; e < OW_EVENTS; e++) out.push(applyEvents(out[e], d, e, e + 1)); return out; };

const image = await editorImage();
const views = submapViews(new OverworldLoads(new OverworldEmulator(new Rom(image.slice())), 6));
check(views.slice(1).every((v) => v.w === 32 && v.h === 28), `the submaps' views: ${views.slice(1).map((v) => `${v.x},${v.y}`).join(' ')}`);

// ---- written back unchanged; every event painted as it is ----
{
  const rom = new Rom(image.slice()), was = rom.data.slice();
  writeEvents(rom, readEvents(rom));
  check(romDiff(was, rom.data) === 0, 'the steps read and written back: no byte changed');
  const d0 = readEvents(rom), base = readL2(rom), runners = eventRunners(rom), maps = progressMaps(d0, base);
  let d = d0;
  const t = performance.now();
  for (let e = 0; e < OW_EVENTS; e++) d = paintEvent(d, base, e, maps[e + 1], eventPlace(runners, views, e, 0));
  const ms = Math.round(performance.now() - t), again = progressMaps(d, base);
  const off = again.map((m, n) => diff(m, maps[n]) ? n : -1).filter((n) => n >= 0);
  check(!off.length, `every event (00–77) painted as its map after it: the same layer 2 at every event progress${off.length ? ` (differs at ${off.map(hx).join(' ')})` : ''} – ${ms} ms`);
  check(d.storage.length <= STORAGE_MAX, `the storage: ${hx(d0.storage.length)} → ${hx(d.storage.length)} places, ${d0.steps.flat().length} → ${d.steps.flat().length} steps, ${d0.silent.flat().length} → ${d.silent.flat().length} silent`);
  const s = new RomEditSession(rom);
  s.edit('Events', () => writeEvents(rom, d));
  const emu = new OverworldEmulator(rom), wrong: string[] = [];
  for (const n of [1, 0x0c, 0x30, 0x6f, OW_EVENTS]) for (const r of [0, 1]) {
    const k = diff(gameL2(emu.load(r, n)), maps[n].subarray(r * 0x1000, r * 0x1000 + 0x1000));
    if (k) wrong.push(`${hx(n)}/${r}: ${k}`);
  }
  check(!wrong.length, `written: the game shows the same layer 2 (progress 01, 0C, 30, 6F, 78, both regions) ${wrong.join(' ')}`);
}

// ---- a change painted for level 105's normal exit ----
const rom = new Rom(image.slice());
const TL = 0x29, e = baseEvent(rom, TL), runners = eventRunners(rom), tile = readTranslevels(rom).indexOf(TL);
check(eventTitle(runners, e) === 'Level 105 · normal exit', `event ${hx(e)}: “${eventTitle(runners, e)}”, its level tile on submap ${submapOf(views, tile)}`);
const d = readEvents(rom), base = readL2(rom), before = applyEvents(base, d, 0, e);
const v = views[submapOf(views, tile)];
// a path 2 tiles high from the view's left to its right (region 1), and 2x2 tiles on the main map (region 0)
const word = 0x1000 | 0x8a; // a tile of the map with palette 4
const onSub = Array.from({ length: 20 }, (_, k) => l2Index(1, v.x + 4 + (k >> 1), v.y + 6 + (k & 1)));
const onMain = [l2Index(0, 10, 10), l2Index(0, 11, 10), l2Index(0, 10, 11), l2Index(0, 11, 11)];
const place = eventPlace(runners, views, e, 0);
// a stroke on layer 2 as after event `ev` (the map after it from the ROM), cells l2Index painted with `v`; its ROM edit
// (in `s`, or written without one) and the map painted
function eventStroke(rom: Rom, ev: number, cells: number[], v: number, pl = eventPlace(eventRunners(rom), views, ev, 0), s?: RomEditSession): Uint16Array {
  const dd = readEvents(rom), b = readL2(rom);
  const em: OwEventMaps = { event: ev, after: applyEvents(b, dd, 0, ev + 1), l1: null, game: null, without: undefined, place: () => pl };
  const st = new OverworldStroke(rom, 'l2', readMaps(rom), () => false, em);
  for (const i of cells) { const { r, x, y } = l2XY(i); st.paint(r, x, y, v); }
  const end = st.end();
  if (s) s.edit(end.label, end.write!); else end.write!();
  return em.after;
}
const s = new RomEditSession(rom);
const loads = new OverworldLoads(new OverworldEmulator(rom), 4), kept = loads.get(0, e + 1);
const painted = eventStroke(rom, e, [...onSub, ...onMain], word, place, s);
const d1 = readEvents(rom);
const shown = gameL2(loads.get(0, e + 1));
check(shown !== gameL2(kept) && onMain.every((i) => shown[i] === word), 'a kept overworld load: loaded again, the main map shows the painted tiles');
check(s.history.undoStack.length === 1 && s.history.undoStack[0].label === `${eventTitle(runners, e)}: paint`, `one ROM edit (“${s.history.undoStack[0]?.label}”)`);
const subTiles = new Set(d1.steps[e].flatMap((p) => pieceTiles(d1, p)));
const silentTiles = new Set(d1.silent[e].filter((p) => p.layer === 2).flatMap((p) => pieceTiles(d1, { at: p.tile, pos: p.loc })));
check(onSub.every((i) => subTiles.has(i)) && onMain.every((i) => silentTiles.has(i)) && !onMain.some((i) => subTiles.has(i)),
  `the submap's tiles are steps (${d1.steps[e].length}), the main map's silent (${d1.silent[e].filter((p) => p.layer === 2).length})`);
check(!diff(applyEvents(base, readEvents(rom), 0, e + 1), painted) && !diff(applyEvents(base, readEvents(rom), 0, e), before), 'read back: the map after the event is the painted one, the one before as it was');
const emu = new OverworldEmulator(rom);
check(onSub.every((i) => gameL2(emu.load(1, e + 1))[i - 0x1000] === word) && onMain.every((i) => gameL2(emu.load(0, e + 1))[i] === word) && onSub.every((i) => gameL2(emu.load(1, e))[i - 0x1000] === before[i]),
  `the game at event progress ${hx(e + 1)} shows them, at ${hx(e)} not`);

// passing level 105 with its normal exit in a new game: the frame each painted tile appears in VRAM (while it fades in
// with palette bit 12 cleared, $04E6F9), the tilemap after
function pass(rom: Rom): { frame: Map<number, number>; tilemap: Uint16Array } | null {
  const le = new LevelEmulator(rom), sn = le.snes, w = sn.wram;
  const p = PlaySession.overworld(le, tile);
  if (!p.enter()) return null;
  w[RAM.levelExit] = 1; w[RAM.levelBeaten] = 1; w[RAM.midwayTouched] = 1;
  w[RAM.gameMode] = GM.overworldReturn;
  p.follow();
  const frame = new Map<number, number>();
  for (let f = 0; f < 3000; f++) {
    p.frame();
    const at = (sn.ppuRegs[0x08] & 0xfc) << 9;
    for (const i of onSub) if (!frame.has(i)) { const k = i - 0x1000; if (((sn.vram[at + k * 2] | (sn.vram[at + k * 2 + 1] << 8)) & 0xefff) === (word & 0xefff)) frame.set(i, f); }
    if (frame.size === onSub.length && w[RAM.owEvents + (e >> 3)] & (0x80 >> (e & 7)) && f > 200) break;
  }
  return { frame, tilemap: Uint16Array.from({ length: 0x2000 }, (_, i) => w[0x14000 + i * 2] | (w[0x14001 + i * 2] << 8)) };
}
// the frame each step's painted tiles appeared in
const stepFrames = (r: NonNullable<ReturnType<typeof pass>>, dd: EventData) =>
  dd.steps[e].map((p) => pieceTiles(dd, p).filter((i) => onSub.includes(i))).filter((l) => l.length).map((l) => Math.max(...l.map((i) => r.frame.get(i) ?? -1)));
const run = pass(rom);
check(!!run && run.frame.size === onSub.length && onMain.every((i) => run.tilemap[i] === word),
  `passed: the submap's painted tiles appear (${run?.frame.size}/${onSub.length}), the main map's are in the tilemap (silent)`);
const frames = run ? stepFrames(run, d1) : [];
check(frames.length > 1 && frames.every((f, k) => f >= 0 && (!k || f > frames[k - 1])), `animated: one step after the other, in their order (frames ${frames.join(' ')})`);

// the steps reversed: the game shows them the other way round
const n = d1.steps[e].length, d2 = reorderSteps(readEvents(rom), e, Array.from({ length: n }, (_, k) => n - 1 - k));
s.edit('Event: order', () => writeEvents(rom, d2));
const rev = pass(rom), revFrames = rev ? stepFrames(rev, d2) : [];
check(revFrames.length === frames.length && revFrames.every((f, k) => f >= 0 && (!k || f > revFrames[k - 1])), `reordered: the game follows the new order (frames ${revFrames.join(' ')})`);
// an order the user chose stays when the event is painted again: the steps it had keep theirs, a new one joins
{
  const dd = readEvents(rom), k = dd.steps[e].length, swapped = reorderSteps(dd, e, [1, 0, ...Array.from({ length: k - 2 }, (_, i) => i + 2)]);
  const more = applyEvents(base, swapped, 0, e + 1);
  more[l2Index(1, v.x + 20, v.y + 20)] = word;
  const again = paintEvent(swapped, base, e, more, place);
  const key = (p: { pos: number }) => p.pos;
  const old = swapped.steps[e].map(key), now = again.steps[e].map(key).filter((p) => old.includes(p));
  check(again.steps[e].length === k + 1 && now.every((p, i) => p === old[i]), `painted again after a reorder: the ${k} steps keep the order chosen, the new one joins (${again.steps[e].length})`);
}
s.undo(); s.undo();
check(romDiff(image, rom.data) === 0, 'undone: the ROM as before');

// events 70–77 (Lunar Magic's 0x78): painted, the game shows them from their event progress on
{
  const r2 = new Rom(image.slice()), ev = 0x75;
  const cells = [l2Index(0, 30, 30), l2Index(0, 31, 30), l2Index(0, 30, 31), l2Index(0, 31, 31)];
  eventStroke(r2, ev, cells, word);
  const em = new OverworldEmulator(r2), at = (n: number) => gameL2(em.load(0, n));
  check(cells.every((i) => at(ev + 1)[i] === word && at(OW_EVENTS)[i] === word) && cells.every((i) => at(ev)[i] !== word),
    `event ${hx(ev)}: shown from event progress ${hx(ev + 1)} on, not at ${hx(ev)} (emulated)`);
}

// layer 1 painted as after level 105's normal exit: a path tile painted a layer 1 change of the event (the game shows it
// from the event on, not before); a level tile is neither painted nor painted over (objects on top of layer 1), the
// translevels stay
{
  const r3 = new Rom(image.slice()), isLevel = levelTiles(r3), maps = readMaps(r3), em = new OverworldEmulator(r3);
  const game = gameL1(em.load(0, e + 1)), without = layer1Without(r3, e), tls = maps.tls.slice();
  const i = Array.from({ length: 0x400 }, (_, k) => k).find((k) => !isLevel(game[k]) && !maps.tls[k] && game[k] === readL1(r3)[k] && game[k] === without[k])!;
  const lvAt = Array.from({ length: 0x400 }, (_, k) => k).find((k) => isLevel(game[k]))!;
  const lt = maps.l1[maps.tls.findIndex((t, k) => !!t && isLevel(maps.l1[k]))], v = game[i] === 0x10 ? 0x11 : 0x10;
  const ev: OwEventMaps = { event: e, after: applyEvents(readL2(r3), readEvents(r3), 0, e + 1), l1: game.slice(), game, without, place: () => place };
  const st = new OverworldStroke(r3, 'l1', maps, isLevel, ev), { x, y } = l1XY(i), at = l1XY(lvAt);
  st.paint(0, x, y, v);
  const levelPainted = st.paint(0, x + 1 < 32 ? x + 1 : x - 1, y, lt) || st.paint(0, at.x, at.y, v);
  const end = st.end(), s3 = new RomEditSession(r3);
  s3.edit(end.label, end.write!);
  const steps = readEvents(r3).silent[e].filter((p) => p.layer === 1 && p.loc === i);
  check(s3.history.undoStack.length === 1 && end.label === `${eventTitle(runners, e)}: paint layer 1` && !levelPainted && readL1(r3)[i] === game[i]
    && steps.length === 1 && steps[0].tile === v && same(readTranslevels(r3), tls), `layer 1 as after the event: the path tile a change of the event, the map before events as it was; a level tile neither painted nor painted over, the translevels as they were`);
  check(gameL1(em.load(0, e + 1))[i] === v && gameL1(em.load(0, e))[i] === game[i], `the game shows it at event progress ${hx(e + 1)}, at ${hx(e)} not`);
}

// a star painted as after level 105's normal exit: a translevel of its own, its flags the ways its paths open there;
// a path painted over it in the event frees it
{
  const r4 = new Rom(image.slice()), isLevel = levelTiles(r4), paths = { kinds: pathKinds(r4), shapes: pathShapes(r4) }, em = new OverworldEmulator(r4);
  const game = gameL1(em.load(0, e + 1)), without = layer1Without(r4, e), tls = readTranslevels(r4), before = readL1(r4);
  const stopLike = (t: number) => paths.kinds[t] === 'stop' || paths.kinds[t] === 'level';
  // (a path tile next to a path, the same before events and without the event, no stop anywhere)
  const i = Array.from({ length: 0x400 }, (_, k) => k).find((k) => ['walk', 'climb', 'swim'].includes(paths.kinds[game[k]]) && !tls[k]
    && game[k] === before[k] && game[k] === without[k] && !stopLike(before[k]) && starDirs(game, k, paths).length)!;
  const stroke = (t: number, from: Uint16Array) => {
    const ev: OwEventMaps = { event: e, after: applyEvents(readL2(r4), readEvents(r4), 0, e + 1), l1: from.slice(), game: from, without, place: () => place };
    const st = new OverworldStroke(r4, 'l1', readMaps(r4), isLevel, ev, paths), { x, y } = l1XY(i);
    st.paint(0, x, y, t);
    st.end().write!();
    return ev.l1!;
  };
  const after = stroke(STAR_TILE, game), tl = readTranslevels(r4)[i];
  check(!!tl && !tls.includes(tl) && initialFlags(r4, tl) === dirFlags(starDirs(after, i, paths)) && same(readL1(r4), before) && gameL1(em.load(0, e + 1))[i] === STAR_TILE,
    `a star painted as after event ${hx(e)} at ${hx(i)}: translevel ${hx(tl)}, flags ${hx(initialFlags(r4, tl))}; the game shows it from the event on, the map before events unchanged`);
  stroke(game[i], after);
  check(readTranslevels(r4)[i] === 0, `a path painted over it in the event frees it (${hx(readTranslevels(r4)[i])})`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('event painting ok');
