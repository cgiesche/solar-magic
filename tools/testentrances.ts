// Secondary entrances over the ROM and the open level as edited (core/entrances.ts): a new one placed like
// the main entrance (position, action, camera start, options), at a spot, moved, removed, switched to an exit
// to the overworld and back; the entrances into the open level and the exit graph follow every edit, also
// an undone one, without being refreshed by hand.
import { Rom } from '../src/core/rom.ts';
import { readSecondaryEntrance, mainSpot, secondarySpot, sameSpot, setCameraRows, cameraRows, OW_NORMAL, type SecondaryEntrance } from '../src/core/level.ts';
import { EditSession } from '../src/core/editsession.ts';
import { SecondaryEntrances } from '../src/core/entrances.ts';
import { readTeleport } from '../src/core/owteleport.ts';
import { isBlank } from '../src/core/exitgraph.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const image = await editorImage();
const N = 0x105, OTHER = 0x106;

function setup() {
  const rom = new Rom(image.slice());
  const s = new EditSession(rom);
  s.open(N);
  return { rom, s, ents: new SecondaryEntrances(s) };
}
const camera = (e: SecondaryEntrance) => [e.cameraRelative, e.cameraOffsetHi, e.fgInitY, e.bgInitY].join();

// like the main entrance: the open level's as edited (not yet saved), with its action, camera start and options
{
  const { s, ents } = setup();
  s.editLevel((lv) => {
    const h = lv.secondary;
    h.entranceAction = 3; h.faceLeft = 1; h.water = 1; h.slippery = 1;
    setCameraRows(h, 7);
  });
  const idx = ents.create(N)!;
  const e = ents.get(idx), h = s.level.secondary;
  check(e.destLevel === N && sameSpot(secondarySpot(e), mainSpot(h)), 'create: at the main entrance of the level as edited');
  check(e.action === 3 && e.faceLeft === 1 && e.water === 1 && e.slippery === 1, 'create: the main entrance\'s action and options');
  check(e.cameraRelative === 1 && cameraRows(e) === 7, 'create: the main entrance\'s camera start');
  check(ents.inOpenLevel().includes(idx), 'create: listed among the entrances into the open level at once');
  check(ents.graph().entrancesOf(N).includes(idx) && ents.graph().freeEntrance() !== idx, 'create: the exit graph knows it at once');
  const other = ents.create(OTHER)!;
  check(other !== idx && ents.get(other).destLevel === OTHER && !ents.inOpenLevel().includes(other), 'create in another level: not into the open one');
}

// at a spot of the open level, moved, removed
{
  const { rom, s, ents } = setup();
  const idx = ents.createAt(0x200 + 40, 0x100)!;
  const e = ents.get(idx);
  check(e.screen === 2 && e.destLevel === N, 'createAt: on the screen of the spot');
  check(!ents.move(idx, 0x200 + 40, 0x100), 'move to where it is: nothing changed');
  check(ents.move(idx, 0x400 + 40, 0x100) && ents.get(idx).screen === 4, 'move: to another screen');
  check(camera(ents.get(idx)) === camera(e), 'move: the camera start kept');
  const p = ents.place(idx);
  check(p.x >= 0x400 && p.x < 0x500, `place: the marker's pixel on screen 4 (${p.x.toString(16)})`);
  const steps = s.romHistory.undoStack.length;
  ents.move(idx, 0x500 + 40, 0x100);
  check(s.romHistory.undoStack.length === steps, 'successive moves of one entrance: one undo step');
  ents.remove(idx);
  check(isBlank(rom, idx) && !ents.inOpenLevel().includes(idx), 'remove: blank, no longer listed');
  s.undo();
  check(ents.inOpenLevel().includes(idx) && ents.get(idx).screen === 5, 'remove undone: listed again at once');
}

// the list of entrances into the open level follows an undone and a redone ROM edit
{
  const { s, ents } = setup();
  const before = ents.inOpenLevel();
  const idx = ents.create(N)!;
  s.undo();
  check(JSON.stringify(ents.inOpenLevel()) === JSON.stringify(before), 'undo of a new entrance: no longer listed');
  check(ents.graph().freeEntrance() === idx, 'undo of a new entrance: free again in the exit graph');
  s.redo();
  check(ents.inOpenLevel().includes(idx), 'redo: listed again');
  ents.edit(idx, 'Target level', (x) => (x.destLevel = OTHER));
  check(!ents.inOpenLevel().includes(idx), 'edit: led elsewhere, no longer listed');
  s.undo();
  check(ents.inOpenLevel().includes(idx), 'edit undone: listed again');
}

// the exit graph follows the open level's exits as edited, also undone
{
  const { s, ents } = setup();
  const idx = ents.create(OTHER)!;
  check(!ents.graph().usersOfEntrance(idx).length, 'graph: a new entrance has no users');
  s.editLevel((lv) => { lv.exits.push({ uid: 999999, screen: 9, dest: idx, secondary: true, flags: 6 }); });
  check(ents.graph().usersOfEntrance(idx).some((r) => r.from === N && r.screen === 9), 'graph: the new exit of the open level as edited');
  s.undo();
  check(!ents.graph().usersOfEntrance(idx).length, 'graph: the exit undone');
}

// switched to an exit to the overworld and back (back: like the main entrance)
{
  const { s, ents } = setup();
  const idx = ents.create(N)!;
  ents.setOverworld(idx, true);
  const o = ents.get(idx);
  check(!!o.overworld && o.overworld.action === OW_NORMAL && o.destLevel === N, 'to the overworld: passing the level with the normal exit, still its level\'s');
  check(!ents.inOpenLevel().includes(idx) && ents.ownedBy(N).includes(idx), 'to the overworld: not an entrance into the level, but the level\'s');
  s.editLevel((lv) => { lv.secondary.entranceAction = 5; });
  ents.setOverworld(idx, false);
  const e = ents.get(idx);
  check(!e.overworld && e.action === 5 && sameSpot(secondarySpot(e), mainSpot(s.level.secondary)), 'back: into its level like the main entrance');
  check(ents.inOpenLevel().includes(idx), 'back: listed again');
}

// an exit to the overworld for a level: its unused one, else a new one
{
  const { s, ents } = setup();
  const a = ents.overworldExit(N)!;
  check(!!ents.get(a).overworld && ents.get(a).destLevel === N, 'overworldExit: a new exit to the overworld of the level');
  check(ents.overworldExit(N) === a, 'overworldExit: the unused one again');
  s.editLevel((lv) => { lv.exits.push({ uid: 999998, screen: 9, dest: a, secondary: true, flags: 6 }); });
  const b = ents.overworldExit(N)!;
  check(b !== a && !!ents.get(b).overworld, 'overworldExit: a used one is not given again');
}

// a teleport destination: a location of the star/pipe table, one ROM edit
{
  const { s, ents } = setup();
  const idx = ents.overworldExit(N)!;
  const steps = s.romHistory.undoStack.length;
  const tile = { submap: 0, x: 0x0c, y: 0x09 };
  ents.teleport(idx, tile);
  const o = ents.get(idx).overworld!;
  const to = readTeleport(s.rom, o.location).to;
  check(!!o.teleport && to?.submap === 0 && to.x === 0x0c && to.y === 0x09, 'teleport: to the tile through its location');
  check(s.romHistory.undoStack.length === steps + 1, 'teleport: one undo step');
  s.undo();
  check(!ents.get(idx).overworld!.teleport, 'teleport undone');
}

// none free: null, nothing changed
{
  const { rom, ents } = setup();
  const all: number[] = [];
  for (let i; (i = ents.graph().freeEntrance()) !== null;) { all.push(i); rom.w8(0x05f800 + i, 1); }
  check(all.length > 0 && ents.create(N) === null && ents.createAt(0, 0) === null, 'none free: create returns null');
}

check(readSecondaryEntrance(new Rom(image.slice()), 0x1cb).destLevel === N, 'fixture: entrance 1CB into 105');
if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
