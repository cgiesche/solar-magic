// The level editing model (core/levelmodel.ts), headless: placing picked items and copies, copy/paste, delete, move,
// resize and reorder in each mode, clamped against the level's geometry, each one undoable level edit.
import { Rom } from '../src/core/rom.ts';
import { EditSession } from '../src/core/editsession.ts';
import { LevelModel, type LevelGeometry, type EditMode } from '../src/core/levelmodel.ts';
import type { LevelObject } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const image = await editorImage();
const N = 0x105;

function setup(geom: LevelGeometry = { l1: { width: 64, height: 27 }, l2: null, vertical: false }) {
  const rom = new Rom(image.slice());
  const s = new EditSession(rom);
  s.open(N);
  const switched: EditMode[] = [];
  const m = new LevelModel({
    rom: () => rom, level: () => s.level, edit: (f) => s.editLevel(f), geometry: () => geom,
    switchMode: (mode) => { switched.push(mode); m.mode = mode; },
  });
  return { rom, s, m, switched };
}
const uids = (xs: { uid: number }[]) => xs.map((o) => o.uid);
const obj = (m: LevelModel, uid: number) => m.currentObjects().find((o) => o.uid === uid)!;

// placing the picked item: an object in layer 1, clamped into the level, selected, one undo step
{
  const { s, m } = setup();
  const n0 = s.level.objects.length;
  check(m.insertAt(70, 30, { kind: 'obj', num: 0x21, ext: 0, size: 0x12 }), 'insert: placed');
  const o = s.level.objects[s.level.objects.length - 1];
  check(s.level.objects.length === n0 + 1 && o.num === 0x21 && o.size === 0x12, 'insert: the object added last');
  check(o.x === 63 && o.y === 26, 'insert: clamped to the level (63, 26)');
  check(m.selection.size === 1 && m.selection.has(o.uid) && m.stampSelection, 'insert: selected, the next right click copies it');
  s.undo();
  check(s.level.objects.length === n0, 'insert: undone in one step');
}

// a block of Map16 tiles: one Direct Map16 object per tile
{
  const { s, m } = setup();
  const n0 = s.level.objects.length;
  m.insertAt(2, 3, { kind: 'obj', num: 0, ext: 5, size: 0, tile: 0x100, block: { w: 2, h: 2 } });
  const add = s.level.objects.slice(n0);
  check(add.length === 4 && add.map((o) => `${o.x},${o.y},${o.tile!.toString(16)}`).join(' ') === '2,3,100 3,3,101 2,4,110 3,4,111', 'block: one object per tile, tiles by row and column');
}

// an object can't go into mode sprites; a sprite goes into any mode and switches to sprites
{
  const { s, m, switched } = setup();
  m.mode = 'spr';
  const n0 = s.level.objects.length;
  check(!m.insertAt(1, 1, { kind: 'obj', num: 0x21, ext: 0, size: 0 }) && s.level.objects.length === n0 && !s.dirty, 'insert object in mode sprites: nothing');
  m.mode = 'l1';
  const k0 = s.level.sprites.length;
  m.insertAt(5, 6, { kind: 'spr', num: 0x0d, extra: 0 });
  check(s.level.sprites.length === k0 + 1 && switched.join() === 'spr' && (m.mode as EditMode) === 'spr', 'insert sprite in layer 1: added, the mode switched to sprites');
  check(m.selectedSprites().length === 1 && m.selectedSprites()[0].x === 5 && m.selectedSprites()[0].y === 6, 'insert sprite: selected at (5, 6)');
}

// picking an item: the selection is no longer stamped
{
  const { m } = setup();
  m.selection = new Set([m.currentObjects()[0].uid]);
  m.stampSelection = true;
  check(m.copiesSelection(), 'stamped selection: a right click copies it');
  m.pickedItem = { kind: 'obj', num: 1, ext: 0, size: 0 };
  check(!m.copiesSelection(), 'item picked after it: the picked item is placed');
  const pl = m.placement(10, 11);
  check(pl?.objects.length === 1 && pl.objects[0].x === 10 && pl.objects[0].num === 1, 'placement: the picked item at the tile');
  m.mode = 'exit';
  check(m.placement(10, 11) === null, 'placement in mode exit: nothing');
}

// copy and paste: copies with new uids, their upper left at the tile, selected; the clipboard is of the mode
{
  const { s, m } = setup();
  const [a, b] = s.level.objects;
  m.selection = new Set([a.uid, b.uid]);
  m.copy();
  const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y);
  m.placeCopy(m.clipboardItems(), 20, 5);
  const pasted = m.selectedObjects();
  check(pasted.length === 2 && !pasted.some((o) => o.uid === a.uid || o.uid === b.uid), 'paste: two new objects selected');
  check(pasted[0].x - pasted[1].x === a.x - b.x && Math.min(...pasted.map((o) => o.x)) === 20 && Math.min(...pasted.map((o) => o.y)) === 5 && minX >= 0 && minY >= 0, 'paste: the arrangement kept, its upper left at (20, 5)');
  m.mode = 'spr';
  check(m.clipboardItems().length === 0, 'clipboard: no sprites in it');
  // the clipboard holds the items as they were copied
  a.x = 99;
  m.mode = 'l1';
  check(m.clipboardItems()[0].x !== 99, 'clipboard: a copy');
}

// copies are clamped too
{
  const { m } = setup();
  const o = m.currentObjects()[0];
  m.selection = new Set([o.uid]);
  const pl = m.copiesAt([o], 500, 500);
  check(pl.objects[0].x === 63 && pl.objects[0].y === 26 && pl.sprites.length === 0, 'copies: clamped to the level');
}

// delete: the mode's selected items only
{
  const { s, m } = setup();
  const o = s.level.objects[0], sp = s.level.sprites[0];
  m.selection = new Set([o.uid, sp.uid]);
  m.mode = 'spr';
  m.deleteSelection();
  check(!s.level.sprites.some((x) => x.uid === sp.uid) && s.level.objects.some((x) => x.uid === o.uid) && m.selection.size === 0, 'delete in mode sprites: the sprite, not the object');
  m.mode = 'l1';
  m.selection = new Set([o.uid]);
  m.deleteSelection();
  check(!s.level.objects.some((x) => x.uid === o.uid), 'delete in layer 1: the object');
  const dirty = s.lastStep;
  m.deleteSelection();
  check(s.lastStep === dirty && s.level.objects.length > 0, 'delete with nothing selected: no edit');
}

// move: by tiles, clamped, one undo step
{
  const { s, m } = setup();
  const o = s.level.objects[0], x0 = o.x, y0 = o.y;
  m.selection = new Set([o.uid]);
  m.moveSelection(1, 0);
  check(obj(m, o.uid).x === Math.min(x0 + 1, 63) && obj(m, o.uid).y === y0, 'move: one tile right');
  m.moveSelection(-1000, -1000);
  check(obj(m, o.uid).x === 0 && obj(m, o.uid).y === 0, 'move: clamped at the upper left');
  s.undo(); s.undo();
  check(obj(m, o.uid).x === x0 && obj(m, o.uid).y === y0, 'move: each an undo step');
}

// limits: layer 2's own geometry in mode layer 2; a vertical level's rows at most $1FF
{
  const { s, m } = setup({ l1: { width: 32, height: 0x300 }, l2: { width: 16, height: 40 }, vertical: true });
  check(m.objectLimits().w === 32 && m.objectLimits().h === 0x1ff, 'limits layer 1: vertical rows capped at $1FF');
  s.level.layer2Objects = [];
  m.mode = 'l2';
  check(m.objectLimits().w === 16 && m.objectLimits().h === 40, 'limits layer 2: its own geometry');
  m.insertAt(100, 100, { kind: 'obj', num: 0x21, ext: 0, size: 0 });
  const o = s.level.layer2Objects![0];
  check(o?.x === 15 && o.y === 39, 'insert in layer 2: into layer 2, clamped to its geometry');
}

// reorder: the selection in front (drawn last) or at the back, in its order; not in mode sprites
{
  const { s, m } = setup();
  const objs: LevelObject[] = s.level.objects, first = objs[0].uid, second = objs[1].uid;
  m.selection = new Set([first, second]);
  m.reorderSelection('front');
  check(uids(s.level.objects).slice(-2).join() === `${first},${second}`, 'reorder front: drawn last, in order');
  m.reorderSelection('back');
  check(uids(s.level.objects).slice(0, 2).join() === `${first},${second}`, 'reorder back: drawn first, in order');
  m.mode = 'spr';
  const before = uids(s.level.objects).join();
  m.reorderSelection('front');
  check(uids(s.level.objects).join() === before, 'reorder in mode sprites: nothing');
}

// resize: the sizes given; without the boxes known the object keeps its place
{
  const { s, m } = setup();
  const o = s.level.objects[0], x0 = o.x, y0 = o.y;
  m.resizeObjects([o], [0x33], () => () => undefined, false);
  check(obj(m, o.uid).size === 0x33 && obj(m, o.uid).x === x0 && obj(m, o.uid).y === y0, 'resize: the new size, the place kept');
  // with boxes: the far edges stay where they are
  const box = (size: number) => ({ x0: 0, y0: 0, x1: size & 15, y1: size >> 4 });
  const p = s.level.objects[1];
  p.x = 10; p.y = 10; p.size = 0x22;
  m.resizeObjects([p], [0x33], () => box, true);
  check(obj(m, p.uid).size === 0x33 && obj(m, p.uid).x === 9 && obj(m, p.uid).y === 9, 'resize far: the right and bottom edges kept');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
