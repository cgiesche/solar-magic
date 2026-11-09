// The level's animation steps carried over to a new load (#440, core/levelanimsteps.ts): an edit loads the level
// anew; the steps are emulated again only when something they read changed.
// - emulated one at a time: the images of animationFrames
// - an object moved: the steps carried (no emulation) wherever nothing they read changed – and every carried set is
//   exactly the one emulated anew for the new load (VRAM and CGRAM); an object far from the start carries
// - the level's ExAnimation list or its graphics changed: emulated anew; another count wanted: emulated anew;
//   steps not all made yet: emulated anew
// node tools/testlevelanimsteps.ts
import { LevelEmulator } from '../src/core/levelemu.ts';
import { LevelAnimSteps } from '../src/core/levelanimsteps.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadLevel, type Level } from '../src/core/level.ts';
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
const made = (lv: Level) => { emu.load(lv.number, levelOverride(rom, lv)); return all(new LevelAnimSteps(emu, COUNT)); };

// ---- one at a time: the images of animationFrames, another level loaded in between ----
{
  const lv = loadLevel(rom, 0x105);
  emu.load(0x105, levelOverride(rom, lv));
  const whole = emu.animationFrames(COUNT, 8);
  emu.load(0x105, levelOverride(rom, lv));
  const s = new LevelAnimSteps(emu, COUNT), got: AnimStep[] = [];
  for (let i = 0; i < COUNT; i++) { got.push(s.next()!); emu.load(0x106); }
  check(sameSteps(got, whole) && s.done && s.next() === null,
    'one at a time: the images of animationFrames, level 106 loaded between them');
}

// ---- objects moved or deleted: carried exactly when nothing they read changed ----
// (not carried: an object near Mario or a sprite – the steps read the level's tiles there – and the last object,
// whose position the loader leaves in WRAM where a step reads it as part of a 16-bit value)
let carried = 0, tried = 0, wrong = 0;
for (const n of [0x105, 0x002]) {
  const lv = loadLevel(rom, n), s = made(lv);
  let kept = 0;
  for (let i = 0; i < lv.objects.length; i++) {
    for (const del of [false, true]) {
      const lv2 = loadLevel(rom, n);
      if (del) lv2.objects.splice(i, 1); else lv2.objects[i].x += 1;
      emu.load(n, levelOverride(rom, lv2));
      const c = s.carry(emu, COUNT);
      tried++;
      if (c) { carried++; kept++; }
      // carried sets checked against emulating anew (a sample: emulating takes long)
      if (c && i % 15 === 0 && !sameSteps(c.steps, made(lv2).steps)) wrong++;
    }
  }
  // (most objects are far from Mario and the sprites: seen 95–97% carried; 85% leaves room for a ROM's changes)
  const of = lv.objects.length * 2;
  check(kept >= of * 0.85, `level ${n.toString(16)}: ${kept} of ${of} objects moved or deleted carry the steps`);
}
check(wrong === 0, `the carried sets checked are the ones emulated anew (${carried} of ${tried} carried)`);
{
  const lv = loadLevel(rom, 0x105);
  const s = made(lv);
  emu.load(0x105, levelOverride(rom, lv));
  const c = s.carry(emu, COUNT)!;
  check(!!c && c.steps.every((st, i) => st === s.steps[i]), 'the level loaded as it was: the very steps carried');
  emu.load(0x105, levelOverride(rom, lv));
  check(c.carry(emu, COUNT) !== null, 'carried again from a carried set');
  emu.load(0x105, levelOverride(rom, lv));
  check(s.carry(emu, COUNT + 1) === null, 'another count wanted: emulated anew');
  emu.load(0x105, levelOverride(rom, lv));
  const part = new LevelAnimSteps(emu, COUNT);
  part.next();
  emu.load(0x105, levelOverride(rom, lv));
  check(part.carry(emu, COUNT) === null, 'steps not all made: emulated anew');
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
  emu.load(0x105, levelOverride(rom, lv));
  check(s.carry(emu, COUNT) === null, 'a slot added to the level\'s ExAnimation list: emulated anew');
  s = made(lv);
  // (its second frame only: the load shows the first, the console as the load left it is the same)
  writeAltFile(rom, 0, alt.fill(0x33, 0x20, 0x40));
  emu.load(0x105, levelOverride(rom, lv));
  const c = s.carry(emu, COUNT);
  check(c === null, 'the graphics of the list\'s second frame changed: emulated anew');
  const anew = made(lv);
  check(anew.steps.some((st) => st.vram[0x600 * 2] === 0x33), 'emulated anew: the new graphics shown');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
