// The tiles an event reveals and destroys, edited with the event (oweventtiles.ts, #339), on the editor's test ROM: a
// castle's event destroys its top, a level's event reveals a tile; a reveal and a destroy added and removed, each one
// ROM edit undone in one step; the game's limits (one reveal and one destroy per event, 0x18 destroys) refused with
// the reason, so is a destroy of a tile the game doesn't destroy (a castle's level tile clicked: set on its top); a
// reveal picked to become another tile changes the cell to the tile the reveal list turns into it. A castle moved in
// the Levels mode (moveLevelTile) moves whole with its destroy, a reveal on its old cell stays; a level tile where its
// top would go keeps the top in place. "Crumbles when beaten" (#368) on a tile another event destroys: on, disabled,
// that event's level exit named, ticking refused (#378).
// node tools/testoweventtiles.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { readL1, writeL1, readTranslevels, l1Index, l1XY, revealAt, revealedTile, readDestroyList, destroyEvent, baseEvent, setBaseEvent, DESTROYS, NO_EVENT } from '../src/core/overworld.ts';
import { eventReveal, eventDestroys, revealRefusal, destroyRefusal, addReveal, removeReveal, addDestroy, removeDestroy, revealSource, crumbles, crumbleRefusal, crumbleState, setCrumbles, destroyTarget } from '../src/core/oweventtiles.ts';
import { refusalText, crumblesByOtherText } from '../src/ui/owrefusal.ts';
import { eventRunners } from '../src/core/owevents.ts';
import { moveLevelTile, placeLevelTile } from '../src/core/owleveltiles.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { refusalOf } from '../src/core/owrefusal.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
// the refusal f throws as JSON ('' none, the message of another error)
const throws = (f: () => void): string => { try { f(); return ''; } catch (e) { return JSON.stringify(refusalOf(e) ?? (e instanceof Error ? e.message : String(e))); } };
const json = (r: unknown) => JSON.stringify(r);

const image = await editorImage();
const fresh = () => { const rom = new Rom(image.slice()); return { rom, s: new RomEditSession(rom) }; };
const isLevel = levelTileTest(pathKinds(new Rom(image.slice())));
const l1 = readL1(new Rom(image.slice()));

// the clean game: Iggy's castle (event 06) destroys its top at 09,01 above its level tile 09,02, which Yoshi's Island
// 4's event (05) reveals; Yoshi's Island 2's event (03) reveals 09,06
const IGGY = 6, YI4 = 5, YI2 = 3, top = l1Index(1, 9, 1), castle = l1Index(1, 9, 2);
{
  const { rom } = fresh();
  check(same(eventDestroys(rom, IGGY), [top]) && l1[top] === 0x4c, `Iggy's castle's event destroys its top (tile 4C at ${hx(top)})`);
  check(eventReveal(rom, YI2) === l1Index(1, 9, 6) && eventReveal(rom, YI4) === castle, 'Yoshi\'s Island 2\'s event reveals 09,06, Yoshi\'s Island 4\'s the castle\'s level tile');
  check(eventReveal(rom, 0x12) === -1 && !eventDestroys(rom, YI2).length, 'an event revealing and destroying nothing: none');
  check(isLevel(l1[castle]) && readTranslevels(rom)[castle] === 0x25, 'the castle\'s level tile: translevel 25 (level 101)');
}

// ---- reveal: added, removed, refused ----
{
  const { rom, s } = fresh();
  const before = rom.data.slice();
  const e = 0x12, i = l1Index(0, 4, 4), t = l1[i];
  check(revealRefusal(rom, e) === null, 'event 12 can reveal a tile');
  check(json(revealRefusal(rom, YI2)) === json({ kind: 'revealTaken', event: YI2, cell: l1Index(1, 9, 6) }), `an event revealing one refused: ${json(revealRefusal(rom, YI2))}`);
  check(json(revealRefusal(rom, 0x78)) === json({ kind: 'revealPastTable', event: 0x78, events: 0x78 }), `past the reveal table: refused (${json(revealRefusal(rom, 0x78))})`);
  // the cell becomes 66: the reveal list turns 6E into it
  check(revealSource(rom, 0x6e, 0x66) === 0x6e && revealSource(rom, t, 0x66) === 0x6e && revealSource(rom, t, 0x01) === -1, 'the tile becoming 66: 6E; none becomes 01');
  s.edit('reveal', () => addReveal(rom, e, i, 0x66), { key: null });
  check(revealAt(rom, e) === i && readL1(rom)[i] === 0x6e && revealedTile(rom, readL1(rom)[i]) === 0x66, `added: event 12 reveals ${hx(i)}, its tile ${hx(t)} now 6E becoming 66`);
  check(readL1(rom).every((v, k) => k === i || v === l1[k]), 'added: no other cell changed');
  check(s.history.undoStack.length === 1, 'added: one ROM edit');
  check(throws(() => addReveal(rom, e, l1Index(0, 5, 5), 0x66)) === json({ kind: 'revealTaken', event: e, cell: i }), 'a second reveal of the event refused');
  check(throws(() => addReveal(rom, 0x13 + 0x40, i, 0x01)) === json({ kind: 'revealNoSource', tile: 0x01 }), 'a tile nothing becomes refused');
  check(throws(() => addReveal(new Rom(image.slice()), 0x12, 0, 0x66)) === json({ kind: 'revealTopLeft' }), 'the main map\'s top left tile refused');
  s.edit('unreveal', () => removeReveal(rom, e), { key: null });
  check(revealAt(rom, e) === 0 && eventReveal(rom, e) === -1, 'removed');
  s.undo(); s.undo();
  check(same(rom.data, before), 'undone: as before');
  // no tile picked: the cell's tile becomes what the reveal list has, the cell unchanged
  const keep = new Rom(image.slice()), c = l1Index(1, 9, 6);
  addReveal(keep, 0x12, c);
  check(readL1(keep)[c] === 0x6e && revealAt(keep, 0x12) === c && revealedTile(keep, 0x6e) === 0x66, 'no tile picked: a 6E cell revealed as it is (becoming 66)');
  check(throws(() => addReveal(new Rom(image.slice()), 0x12, l1Index(0, 4, 4))) === json({ kind: 'revealUnchanged', tile: l1[l1Index(0, 4, 4)] }) && revealedTile(rom, l1[l1Index(0, 4, 4)]) < 0, 'no tile picked on a tile the list has not: refused');
}

// ---- destroy: added, removed, refused ----
{
  const { rom, s } = fresh();
  // (a fortress tile 58 no event destroys, at 04,04 of the main map)
  const i = l1Index(0, 4, 4), m = readL1(rom);
  m[i] = 0x58;
  writeL1(rom, m);
  const before = rom.data.slice(), e = 0x12;
  check(destroyRefusal(rom, e) === null, 'event 12 can destroy a tile');
  check(json(destroyRefusal(rom, IGGY)) === json({ kind: 'destroyTaken', event: IGGY, cell: top }), `an event destroying one refused: ${json(destroyRefusal(rom, IGGY))}`);
  check(destroyRefusal(rom, 0x78)?.kind === 'destroyPastEvents', 'past the last event refused');
  const none = throws(() => addDestroy(rom, e, l1Index(0, 6, 6)));
  check(none === json({ kind: 'destroyNothing', tile: l1[l1Index(0, 6, 6)] }) && !eventDestroys(rom, e).length, `a tile the game doesn't destroy refused: ${none}`);
  s.edit('destroy', () => addDestroy(rom, e, i), { key: null });
  check(same(eventDestroys(rom, e), [i]) && destroyEvent(rom, i) === e, 'added: event 12 destroys it');
  const c2 = new Rom(image.slice());
  addDestroy(c2, e, castle);
  check(same(eventDestroys(c2, e), [top]), 'a castle\'s level tile clicked: the destroy set on its top');
  check(s.history.undoStack.length === 1, 'added: one ROM edit');
  s.edit('undestroy', () => removeDestroy(rom, e, i), { key: null });
  check(!eventDestroys(rom, e).length && destroyEvent(rom, i) === NO_EVENT, 'removed');
  s.undo(); s.undo();
  check(same(rom.data, before), 'undone: as before');
  // all 0x18 used
  const used = readDestroyList(rom).filter((d) => d.event !== NO_EVENT).length;
  for (let n = used, ev = 0x50; n < DESTROYS; ev++) if (!eventDestroys(rom, ev).length) { addDestroy(rom, ev, i); n++; }
  check(readDestroyList(rom).every((d) => d.event !== NO_EVENT), `filled: all ${DESTROYS} used`);
  const why = destroyRefusal(rom, 0x13);
  check(json(why) === json({ kind: 'destroysFull', event: 0x13, max: DESTROYS }) && throws(() => addDestroy(rom, 0x13, i)) === json(why), `the ${DESTROYS + 1}th refused: ${json(why)}`);
}

// ---- a castle moved: its destroy with it, the reveal on its old cell stays ----
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), { x, y } = l1XY(castle), to = l1Index(1, x + 1, y);
  s.edit('move', () => moveLevelTile(rom, castle, to), { key: null });
  check(readTranslevels(rom)[to] === 0x25 && readL1(rom)[to] === l1[castle], 'moved: the level tile at 0A,02');
  const newTop = l1Index(1, x + 1, y - 1);
  check(readL1(rom)[newTop] === 0x4c && readL1(rom)[top] === l1[newTop], 'moved: the castle whole – its top (4C) above it, the tile that was there in the top\'s old place');
  check(same(eventDestroys(rom, IGGY), [newTop]), 'moved: its destroy (on the top above it) moved along, to 0A,01');
  check(readL1(rom).every((v, k) => [castle, to, top, newTop].includes(k) || v === l1[k]), 'moved: no other cell changed');
  check(eventReveal(rom, YI4) === castle, 'moved: the reveal on its old cell stays');
  check(readDestroyList(rom).every((d, k) => d.event === IGGY || d.tile === readDestroyList(new Rom(image.slice()))[k].tile), 'moved: no other destroy changed');
  check(s.history.undoStack.length === 1, 'moved: one ROM edit');
  s.undo();
  check(same(rom.data, before), 'moved: undo restores the ROM');
  // moved back: as before (the destroy follows the level tile both ways)
  moveLevelTile(rom, castle, to);
  moveLevelTile(rom, to, castle);
  check(same(eventDestroys(rom, IGGY), [top]), 'moved there and back: the destroy back on the top');
  // moved one cell up (onto its own top) and one down: the castle whole above the new cell
  for (const dy of [-1, 1]) {
    const r = new Rom(image.slice()), at = l1Index(1, x, y + dy), above = l1Index(1, x, y + dy - 1);
    moveLevelTile(r, castle, at);
    const m = readL1(r);
    check(m[at] === l1[castle] && m[above] === 0x4c && same(eventDestroys(r, IGGY), [above]) && readTranslevels(r)[at] === 0x25,
      `moved one ${dy < 0 ? 'up' : 'down'}: level tile, top and destroy one ${dy < 0 ? 'up' : 'down'}`);
    check(m.filter((v, k) => v !== l1[k]).length === 3 && (dy < 0 ? m[castle] === l1[l1Index(1, x, y - 2)] : m[top] === l1[at]), `moved one ${dy < 0 ? 'up' : 'down'}: the tile there in the cell left free`);
  }
  // a level tile where the top would go: it stays, the top and its destroy too
  {
    const r = new Rom(image.slice()), above = l1Index(1, x + 1, y - 1);
    placeLevelTile(r, above, 0x56, 0x30);
    moveLevelTile(r, castle, to);
    check(readL1(r)[above] === 0x56 && readTranslevels(r)[above] === 0x30 && readL1(r)[top] === 0x4c && same(eventDestroys(r, IGGY), [top]),
      'a level tile where the top would go: it stays, so do the top and its destroy');
  }
  // a level tile without a destroy: the list untouched
  const plain = l1Index(1, 9, 6), r2 = new Rom(image.slice()), d0 = readDestroyList(r2);
  moveLevelTile(r2, plain, l1Index(1, 10, 6));
  check(JSON.stringify(readDestroyList(r2)) === JSON.stringify(d0), 'a level tile no event destroys moved: the destroys stay');
}

// ---- "Crumbles when beaten" (#368): Iggy's castle off and on again, each one ROM edit; refused where the game can't ----
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), tl = readTranslevels(rom)[castle];
  check(baseEvent(rom, tl) === IGGY && crumbles(rom, castle, tl) && crumbleRefusal(rom, castle, tl) === null, 'Iggy\'s castle crumbles when beaten (its event destroys its top)');
  const plain = readL1(rom).findIndex((t, i) => isLevel(t) && destroyTarget(rom, i) < 0);
  check(destroyTarget(rom, castle) === top && plain >= 0, `the checkbox: on a castle's level tile (its top), not on a plain level tile (${plain.toString(16)})`);
  s.edit('off', () => setCrumbles(rom, castle, tl, false), { key: null });
  check(!crumbles(rom, castle, tl) && !eventDestroys(rom, IGGY).length && s.history.undoStack.length === 1, 'off: no destroy in its event, one ROM edit');
  s.edit('on', () => setCrumbles(rom, castle, tl, true), { key: null });
  check(crumbles(rom, castle, tl) && same(rom.data, before) && s.history.undoStack.length === 2, 'on again: one ROM edit, the ROM as before');
  s.undo(); s.undo();
  check(same(rom.data, before), 'undone: as before');
  // refused: a plain level tile, a level without a base event, its event destroying another tile, the list full, past the events
  const json = (r: unknown) => JSON.stringify(r);
  check(crumbleRefusal(rom, plain, readTranslevels(rom)[plain])?.kind === 'destroyNothing', 'a plain level tile: the game destroys none');
  const r1 = new Rom(image.slice());
  removeDestroy(r1, IGGY, top); // (its event 06 still run: by Yoshi's Island 4's secret exit)
  setBaseEvent(r1, tl, NO_EVENT);
  check(json(crumbleRefusal(r1, castle, tl)) === json({ kind: 'crumbleNoEvent', tl }) && !crumbles(r1, castle, tl), 'no base event: refused');
  const r2 = new Rom(image.slice());
  setCrumbles(r2, castle, tl, false);
  // (a fortress tile 58 at 04,04 of the main map)
  const m2 = readL1(r2); m2[l1Index(0, 4, 4)] = 0x58; writeL1(r2, m2);
  addDestroy(r2, IGGY, l1Index(0, 4, 4));
  check(json(crumbleRefusal(r2, castle, tl)) === json({ kind: 'destroyTaken', event: IGGY, cell: l1Index(0, 4, 4) }), 'its event destroying another tile: refused');
  const r3 = new Rom(image.slice());
  setCrumbles(r3, castle, tl, false);
  const m3 = readL1(r3); m3[l1Index(0, 4, 4)] = 0x58; writeL1(r3, m3); // (a fortress: the list filled with another cell)
  for (let ev = 0x50; readDestroyList(r3).some((d) => d.event === NO_EVENT); ev++) addDestroy(r3, ev, l1Index(0, 4, 4));
  check(crumbleRefusal(r3, castle, tl)?.kind === 'destroysFull' && refusalOf((() => { try { setCrumbles(r3, castle, tl, true); } catch (e) { return e; } })())?.kind === 'destroysFull', 'the destroy list full: refused');
  const r4 = new Rom(image.slice());
  removeDestroy(r4, IGGY, top);
  setBaseEvent(r4, tl, 0x80);
  check(crumbleRefusal(r4, castle, tl)?.kind === 'destroyPastEvents', 'a base event past the last event: refused');
}

// ---- #378: Iggy's castle destroyed by another level's event: the checkbox on and disabled, that level's exit named;
// ticking it refused with that reason, no second destroy of the cell; unticking changes nothing ----
{
  const rom = new Rom(image.slice()), tl = readTranslevels(rom)[castle];
  removeDestroy(rom, IGGY, top);
  addDestroy(rom, YI2, castle);
  const list = json(readDestroyList(rom)), by = { kind: 'crumblesByOther', event: YI2, cell: top };
  const st = crumbleState(rom, castle, tl);
  check(!crumbles(rom, castle, tl) && st.on && json(st.why) === json(by), `on, disabled: ${json(st)}`);
  const words = refusalText(rom, st.why!);
  check(crumblesByOtherText(rom, YI2) === 'Already crumbles when the normal exit of Yoshi\'s Island 2 is beaten' && words.startsWith(crumblesByOtherText(rom, YI2)),
    `the reason names that level's exit: "${words}"`);
  check(throws(() => setCrumbles(rom, castle, tl, true)) === json(by) && json(readDestroyList(rom)) === list, 'ticking it: refused with that reason, the destroys unchanged');
  setCrumbles(rom, castle, tl, false);
  check(json(readDestroyList(rom)) === list, 'unticking it: the other level\'s destroy stays');
  // without a base event of its own: on as well
  setBaseEvent(rom, tl, NO_EVENT);
  check(json(crumbleState(rom, castle, tl)) === json({ on: true, why: by }), 'no base event of its own: on, the other level named');
  // both destroying it: on, its own (can be unticked)
  const r2 = new Rom(image.slice());
  addDestroy(r2, YI2, castle);
  check(json(crumbleState(r2, castle, tl)) === json({ on: true, why: null }), 'its own event and another destroying it: on, editable');
  // an event no level exit runs destroying it: on, disabled as well – no second destroy of the cell
  const r3 = new Rom(image.slice()), runners = eventRunners(r3);
  let dead = 0x77; while (runners.has(dead)) dead--;
  removeDestroy(r3, IGGY, top);
  addDestroy(r3, dead, castle);
  const l3 = json(readDestroyList(r3)), by3 = { kind: 'crumblesByOther', event: dead, cell: top };
  check(json(crumbleState(r3, castle, tl)) === json({ on: true, why: by3 }) && throws(() => setCrumbles(r3, castle, tl, true)) === json(by3) && json(readDestroyList(r3)) === l3,
    `event ${hx(dead)} no exit runs destroying it: on, ticking refused, "${refusalText(r3, by3 as never)}"`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
