// The level's animation steps carried over to a new load (#440, core/levelanimsteps.ts): an edit loads the level
// anew; the steps are emulated again only when something they read changed.
// - emulated one at a time: the images of animationFrames
// - an object moved: the steps carried (no emulation) wherever nothing they read changed – and every carried set is
//   exactly the one emulated anew for the new load (VRAM and CGRAM); an object far from the start carries
// - the steps run without Mario and the sprites (#444): they read none of the level's tiles around Mario's start; the
//   object under him and a Direct Map16 tile moved onto the ground there carry
// - something they read changed (an object or a Direct Map16 tile added to the end, a sprite added at the level's
//   start): carried as a guess and checked by emulation – the same steps stay, the very arrays; a guess that is
//   wrong (the level's palette) ends as the steps emulated; a guess not checked through carries from the set it was
//   made from
// - the level's ExAnimation list or its graphics changed: emulated anew; another count wanted: emulated anew;
//   steps not all made yet: emulated anew
// node tools/testlevelanimsteps.ts
import { LevelEmulator } from '../src/core/levelemu.ts';
import { joinHooks } from '../src/core/snes.ts';
import { LevelAnimSteps } from '../src/core/levelanimsteps.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadLevel, newUid, serializeLevelSprites, type Level } from '../src/core/level.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { RAM, MAP_HI, map16Tile, marioX, marioY, marioTile, mapAddr } from '../src/core/ram.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { installExAnim, exanimInstalled, writeLevelList, writeAltFile, emptyList } from '../src/core/exanim.ts';
import type { AnimStep } from '../src/core/render.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom((await editorImage()).slice());
if (!exanimInstalled(rom)) installExAnim(rom);
const emu = new LevelEmulator(rom);
emu.boot();
const COUNT = 8;

const bytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, k) => v === b[k]);
const sameSteps = (a: AnimStep[], b: AnimStep[]) =>
  a.length === b.length && a.every((s, i) => bytes(s.vram, b[i].vram) && bytes(s.cgram, b[i].cgram));
const all = (s: LevelAnimSteps) => { while (s.next()); return s; };
// (the sprites as edited too, as the editor loads a level)
const ov = (lv: Level) => ({ ...levelOverride(rom, lv), sprites: serializeLevelSprites(rom, lv) });
const made = (lv: Level) => { emu.load(lv.number, ov(lv)); return all(new LevelAnimSteps(emu, COUNT)); };
// a guess checked through: whether it was right
const checked = (s: LevelAnimSteps) => { for (;;) { const r = s.check(); if (r !== null) return r; } };

// ---- one at a time: the images of animationFrames, another level loaded in between ----
{
  const lv = loadLevel(rom, 0x105);
  emu.load(0x105, ov(lv));
  const whole = emu.animationFrames(COUNT, 8);
  emu.load(0x105, ov(lv));
  const s = new LevelAnimSteps(emu, COUNT), got: AnimStep[] = [];
  for (let i = 0; i < COUNT; i++) { got.push(s.next()!); emu.load(0x106); }
  check(sameSteps(got, whole) && s.done && s.next() === null,
    'one at a time: the images of animationFrames, level 106 loaded between them');
}

// ---- objects moved or deleted: carried exactly when nothing they read changed ----
// (not carried: the last object, whose position the loader leaves in WRAM where a step reads it as part of a 16-bit
// value, one at the camera's edge – the first frames draw a column of the level's tiles there –, one that changes
// Mario's pose at the start)
let carried = 0, tried = 0, wrong = 0;
for (const n of [0x105, 0x002]) {
  const lv = loadLevel(rom, n), s = made(lv);
  let kept = 0;
  for (let i = 0; i < lv.objects.length; i++) {
    for (const del of [false, true]) {
      const lv2 = loadLevel(rom, n);
      if (del) lv2.objects.splice(i, 1); else lv2.objects[i].x += 1;
      emu.load(n, ov(lv2));
      const c = s.carry(emu, COUNT);
      tried++;
      // (carried for sure: a guess is counted as not carried)
      if (c?.checked) { carried++; kept++; }
      // carried sets checked against emulating anew (a sample: emulating takes long)
      if (c?.checked && i % 15 === 0 && !sameSteps(c.steps, made(lv2).steps)) wrong++;
    }
  }
  // (seen 97% carried; 85% leaves room for a ROM's changes)
  const of = lv.objects.length * 2;
  check(kept >= of * 0.85, `level ${n.toString(16)}: ${kept} of ${of} objects moved or deleted carry the steps`);
}
check(wrong === 0, `the carried sets checked are the ones emulated anew (${carried} of ${tried} carried)`);
{
  const lv = loadLevel(rom, 0x105);
  const s = made(lv);
  emu.load(0x105, ov(lv));
  const c = s.carry(emu, COUNT)!;
  check(!!c && c.steps.every((st, i) => st === s.steps[i]), 'the level loaded as it was: the very steps carried');
  emu.load(0x105, ov(lv));
  check(c.carry(emu, COUNT) !== null, 'carried again from a carried set');
  emu.load(0x105, ov(lv));
  check(s.carry(emu, COUNT + 1) === null, 'another count wanted: emulated anew');
  emu.load(0x105, ov(lv));
  const part = new LevelAnimSteps(emu, COUNT);
  part.next();
  emu.load(0x105, ov(lv));
  check(part.carry(emu, COUNT) === null, 'steps not all made: emulated anew');
}

// ---- next to Mario's start: objects and a Direct Map16 tile moved carry (#444) ----
{
  const lv = loadLevel(rom, 0x105);
  const r = emu.load(0x105, ov(lv));
  const { tx, ty } = marioTile(marioX(r.wram), marioY(r.wram));
  // the steps read none of the tiles around him (before #444 Mario read the one he stands on, and the one his feet
  // are in)
  emu.load(0x105, ov(lv));
  const s = new LevelAnimSteps(emu, COUNT), outer = emu.snes.hook;
  const around = new Set([mapAddr(tx, ty), mapAddr(tx, ty + 1)].flatMap((a) => [a, a + MAP_HI]));
  let read = false;
  const watch = { onWramRead: (a: number) => { if (around.has(a)) read = true; } };
  emu.snes.hook = outer ? joinHooks(outer, watch) : watch;
  try { all(s); } finally { emu.snes.hook = outer; }
  check(!read, `the steps don't read the tiles at Mario's start (${tx}, ${ty}) or under it`);
  // objects moved: each one drawing a tile next to him (the ground under him, what stands beside him), one tile on
  // (the last object excepted: see above)
  const ground = mapAddr(tx, ty + 1);
  const near = lv.objects.slice(0, -1).flatMap((_, k) => {
    const l = loadLevel(rom, 0x105);
    l.objects.splice(k, 1);
    const w = emu.load(0x105, ov(l)).wram;
    return [-1, 0, 1, 2, 3].some((d) => [ty, ty + 1].some((y) => map16Tile(w, mapAddr(tx + d, y)) !== map16Tile(r.wram, mapAddr(tx + d, y)))) ? [k] : [];
  });
  check(near.length >= 2, `${near.length} objects draw tiles next to Mario's start`);
  let ok = true;
  for (const k of near) {
    const lv2 = loadLevel(rom, 0x105);
    lv2.objects[k].x += lv2.objects[k].x > 0 ? -1 : 1;
    emu.load(0x105, ov(lv2));
    const c = s.carry(emu, COUNT);
    if (!c?.checked || !sameSteps(c.steps, made(lv2).steps)) ok = false;
  }
  check(ok, 'each moved one tile: the steps carried, the same as emulated anew');
  // a Direct Map16 tile moved onto the ground under him
  // (any tile not the ground's: 0x130, a cement block; put after the first object, the ground, which would draw over it)
  const at = (x: number) => {
    const l = loadLevel(rom, 0x105);
    l.objects.splice(1, 0, { uid: newUid(), num: 0, ext: DM16_EXT, x, y: ty + 1, size: 0, tile: 0x130 });
    return l;
  };
  const sm = made(at(tx + 4));
  emu.load(0x105, ov(at(tx)));
  const cm = sm.carry(emu, COUNT);
  check(map16Tile(emu.snes.wram, ground) === 0x130 && !!cm?.checked && sameSteps(cm.steps, made(at(tx)).steps),
    'a Direct Map16 tile moved onto the ground under Mario\'s start: the steps carried, the same as emulated anew');
}

// ---- something they read changed: carried as a guess, checked by emulation ----
for (const n of [0x105, 0x002]) {
  const lv = loadLevel(rom, n), s = made(lv);
  const edits: [string, (l: Level) => void][] = [
    ['an object added to the end', (l) => l.objects.push({ ...l.objects[0], uid: newUid(), x: l.objects[0].x + 3 })],
    ['a Direct Map16 tile added to the end', (l) => l.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 20, y: 10, size: 0, tile: 0x130 })],
    ['a sprite added at the level\'s start', (l) => l.sprites.push({ ...l.sprites[0], uid: newUid(), x: 4 })],
    ['the first sprite deleted', (l) => l.sprites.splice(0, 1)],
  ];
  for (const [what, edit] of edits) {
    const lv2 = loadLevel(rom, n);
    edit(lv2);
    emu.load(n, ov(lv2));
    const c = s.carry(emu, COUNT);
    const guess = !!c && !c.checked && c.done && c.next() === null, arrays = c?.steps.slice() ?? [];
    const right = !!c && checked(c);
    check(guess && right && c!.checked && c!.steps.every((st, i) => st === arrays[i]) && sameSteps(c!.steps, made(lv2).steps),
      `level ${n.toString(16)}, ${what}: carried as a guess, checked the same as emulated anew`);
    // (once checked it is a set like one emulated: the level loaded again carries for sure)
    emu.load(n, ov(lv2));
    check(!!c!.carry(emu, COUNT)?.checked, '  loaded again: carried for sure');
  }
  // a guess not checked through: the next load is carried from the set the guess was made from
  const a = loadLevel(rom, n), b = loadLevel(rom, n);
  a.objects.push({ ...a.objects[0], uid: newUid(), x: a.objects[0].x + 3 });
  emu.load(n, ov(a));
  const g = s.carry(emu, COUNT)!;
  g.check();
  emu.load(n, ov(b));
  const back = g.carry(emu, COUNT);
  check(!!back?.checked && back.steps.every((st, i) => st === s.steps[i]), `level ${n.toString(16)}: a guess half checked, the level as it was loaded: the first set's steps carried for sure`);
  emu.load(n, ov(a));
  const again = g.carry(emu, COUNT);
  check(!!again && !again.checked && checked(again) && sameSteps(again.steps, made(a).steps), '  the edit loaded again: a guess anew, checked the same');
}
// a guess that is wrong: the frame counter the animations go by changed behind the load (as a load would leave
// another one)
{
  const lv = loadLevel(rom, 0x105), s = made(lv);
  emu.load(0x105, ov(lv));
  emu.snes.wram[RAM.frameCounter] ^= 0x20;
  const c = s.carry(emu, COUNT);
  const guess = !!c && !c.checked;
  const right = !!c && checked(c);
  emu.load(0x105, ov(lv));
  emu.snes.wram[RAM.frameCounter] ^= 0x20;
  const anew = all(new LevelAnimSteps(emu, COUNT));
  check(guess && !sameSteps(anew.steps, s.steps), 'the frame counter changed after the load: a guess, the steps emulated differ from the old ones');
  // (the steps so far are the emulated ones, the others made by next)
  check(!right && c!.checked && sameSteps(all(c!).steps, anew.steps), 'checked: wrong – the steps are those emulated anew');
}

// ---- the level's ExAnimation list and graphics: emulated anew ----
{
  const lv = loadLevel(rom, 0x105);
  const alt = new Uint8Array(0x100).fill(0x11, 0, 0x20).fill(0x22, 0x20, 0x40);
  writeAltFile(rom, 0, alt);
  const list = emptyList();
  list.slots.set(0, { type: 0x01, trigger: 0x00, framesLess1: 1, dest: 0x8000 | 0x0600, frames: [0x00, 0x20] });
  writeLevelList(rom, 0x105, list);
  let s = made(lv);
  list.slots.set(1, { type: 0x14, trigger: 0x00, framesLess1: 1, dest: 0x0021, frames: [0x001f, 0x7c00] });
  writeLevelList(rom, 0x105, list);
  emu.load(0x105, ov(lv));
  check(s.carry(emu, COUNT) === null, 'a slot added to the level\'s ExAnimation list: emulated anew');
  s = made(lv);
  // (its second frame only: the load shows the first, the console as the load left it is the same)
  writeAltFile(rom, 0, alt.fill(0x33, 0x20, 0x40));
  emu.load(0x105, ov(lv));
  const c = s.carry(emu, COUNT);
  check(c === null, 'the graphics of the list\'s second frame changed: emulated anew');
  const anew = made(lv);
  check(anew.steps.some((st) => st.vram[0x600 * 2] === 0x33), 'emulated anew: the new graphics shown');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
