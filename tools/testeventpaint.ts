// Painting a layer 2 event (owevents.ts paintEvent, ADR 0005): the map after the event becomes its steps. Every
// clean game's event painted as it is (its own map after it) and written back leaves the layer 2 of every event
// progress as it was; a painted change is shown by the game – passing the level, the steps on its submap appear one
// after the other in their order (VRAM, frame by frame), those on another submap at once in the tilemap (silent);
// reordering the steps changes the order in the game. All by emulation.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { OverworldEmulator, OverworldLoads, gameL2, readL2, readTranslevels, baseEvent, OW_EVENTS, l2Index } from '../src/core/overworld.ts';
import {
  readEvents, writeEvents, applyEvents, paintEvent, reorderSteps, eventRunners, eventTitle, submapViews, submapOf, eventPlace, pieceTiles,
  STORAGE_MAX, type EventData,
} from '../src/core/owevents.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { editorImage, romDiff } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
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
const d = readEvents(rom), base = readL2(rom), before = applyEvents(base, d, 0, e), after = applyEvents(base, d, 0, e + 1);
const v = views[submapOf(views, tile)];
// a path 2 tiles high from the view's left to its right (region 1), and 2x2 tiles on the main map (region 0)
const word = 0x1000 | 0x8a; // a tile of the map with palette 4
const onSub = Array.from({ length: 20 }, (_, k) => l2Index(1, v.x + 4 + (k >> 1), v.y + 6 + (k & 1)));
const onMain = [l2Index(0, 10, 10), l2Index(0, 11, 10), l2Index(0, 10, 11), l2Index(0, 11, 11)];
const painted = after.slice();
for (const i of [...onSub, ...onMain]) painted[i] = word;
const place = eventPlace(runners, views, e, 0);
const d1 = paintEvent(d, base, e, painted, place);
const s = new RomEditSession(rom);
const loads = new OverworldLoads(new OverworldEmulator(rom), 4), kept = loads.get(0, e + 1);
s.edit('Event: paint', () => writeEvents(rom, d1));
const shown = gameL2(loads.get(0, e + 1));
check(shown !== gameL2(kept) && onMain.every((i) => shown[i] === word), 'a kept overworld load: loaded again, the main map shows the painted tiles');
check(s.history.undoStack.length === 1 && s.history.undoStack[0].label === 'Event: paint', 'one ROM edit');
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
  const r2 = new Rom(image.slice()), d0 = readEvents(r2), b0 = readL2(r2), ev = 0x75;
  const after = applyEvents(b0, d0, 0, ev + 1), cells = [l2Index(0, 30, 30), l2Index(0, 31, 30), l2Index(0, 30, 31), l2Index(0, 31, 31)];
  for (const i of cells) after[i] = word;
  writeEvents(r2, paintEvent(d0, b0, ev, after, eventPlace(eventRunners(r2), views, ev, 0)));
  const em = new OverworldEmulator(r2), at = (n: number) => gameL2(em.load(0, n));
  check(cells.every((i) => at(ev + 1)[i] === word && at(OW_EVENTS)[i] === word) && cells.every((i) => at(ev)[i] !== word),
    `event ${hx(ev)}: shown from event progress ${hx(ev + 1)} on, not at ${hx(ev)} (emulated)`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('event painting ok');
