// ExAnimation color rotations (types 18-1B, Lunar Magic's help level_ex20.htm): the editor's model of a
// rotation (rotationStep, rotated, rotationRange, a step every 8 × delay game frames) against what the
// engine does in the emulator – right and left, the delay, waiting for the trigger, reversing while it
// holds; and the number of 8-frame steps after which a list's animations repeat (exanimPeriod).
import { LevelEmulator } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { emptyList, writeLevelList, rotationStep, rotated, rotationRange, setRotationRange, stepsPerSecond, exanimPeriod, heldColors, type ExSlot } from '../src/core/exanim.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
const rom = new Rom((await editorImage()).slice());
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const emu = new LevelEmulator(rom);
emu.boot();
const LEVEL = 0x105;

// the colors [first, first + n) of a CGRAM image
const colors = (cgram: Uint8Array, first: number, n: number) => Array.from({ length: n }, (_, i) => cgram[(first + i) * 2] | (cgram[(first + i) * 2 + 1] << 8));
// a range of distinct colors in the level's palette (rows 2-5, away from the game's flashing $64)
const loaded = emu.load(LEVEL);
let FIRST = -1;
for (let c = 0x21; c < 0x5c && FIRST < 0; c++) if (new Set(colors(loaded.cgram, c, 5)).size === 5 && (c & 15) && ((c + 4) & 15) >= 4) FIRST = c;
check(FIRST > 0, `distinct colors in level ${LEVEL.toString(16)} at ${FIRST.toString(16)}`);
const N = 5;

// the range every game frame after the load, and the frames at which it changed
function run(slot: ExSlot, frames: number, onOff = false): { states: number[][]; at: number[] } {
  const l = emptyList();
  l.slots.set(0, slot);
  writeLevelList(rom, LEVEL, l);
  emu.load(LEVEL, { onOffSwitch: onOff });
  const out = { states: [] as number[][], at: [] as number[] };
  let prev = '';
  const snaps = emu.animationFrames(frames, 1);
  snaps.forEach((s, i) => {
    const c = colors(s.cgram, FIRST, N), key = c.join();
    if (key !== prev) { out.states.push(c); out.at.push(i); prev = key; }
  });
  return out;
}
const slotOf = (type: number, trigger: number, delay: number): ExSlot => {
  const s: ExSlot = { type, trigger, framesLess1: delay - 1, dest: 0, frames: [] };
  setRotationRange(s, FIRST, N);
  return s;
};
// each state is the one before it rotated once the way the model says, every 8 × delay frames
function follows(name: string, slot: ExSlot, onOff: boolean, delay: number): void {
  const r = run(slot, 8 * delay * 7 + 1, onOff);
  const dir = rotationStep(slot.type, slot.trigger, onOff);
  let ok = r.states.length >= 6 && dir !== null;
  for (let i = 1; ok && i < r.states.length; i++) ok = rotated(r.states[i - 1], dir!, 1).join() === r.states[i].join();
  const gaps = r.at.slice(2).map((a, i) => a - r.at[i + 1]);
  check(ok && gaps.every((g) => g === 8 * delay), `${name}: ${r.states.length} states, each the last rotated ${dir}, every ${[...new Set(gaps)].join('/')} frames (want ${8 * delay})`);
}

// ---- the slot's fields ----
{
  const s = slotOf(0x18, 0, 1);
  check(rotationRange(s).first === FIRST && rotationRange(s).count === N && s.dest === (FIRST | ((N - 1) << 8)), 'range in the destination: first color, colors less one');
  setRotationRange(s, 0x10, 0x80);
  check(s.dest === 0x7f10 && rotationRange(s).count === 0x80, '0x80 colors');
  check(rotated([1, 2, 3, 4], 'right', 1).join() === '4,1,2,3' && rotated([1, 2, 3, 4], 'left', 1).join() === '2,3,4,1' && rotated([1, 2, 3], 'right', 4).join() === '3,1,2', 'rotated');
  check(stepsPerSecond(1) === 7.5 && stepsPerSecond(4) === 1.875, 'steps per second');
}

// ---- against the engine ----
follows('right, always', slotOf(0x18, 0, 1), false, 1);
follows('left, always', slotOf(0x1a, 0, 1), false, 1);
follows('right, delay 3', slotOf(0x18, 0, 3), false, 3);
follows('right, ON/OFF switch OFF', slotOf(0x18, 3, 1), true, 1);
follows('right, reverse on trigger, not holding', slotOf(0x19, 3, 2), false, 2);
follows('right, reverse on trigger, holding', slotOf(0x19, 3, 2), true, 2);
follows('left, reverse on trigger, holding', slotOf(0x1b, 3, 1), true, 1);
{
  const r = run(slotOf(0x18, 3, 1), 80, false);
  check(rotationStep(0x18, 3, false) === null && r.states.length === 1, `waits for its trigger (${r.states.length} states)`);
  const l = run(slotOf(0x1a, 3, 1), 80, false);
  check(rotationStep(0x1a, 3, false) === null && l.states.length === 1, `left waits for its trigger (${l.states.length} states)`);
}

// ---- colors the game keeps setting itself (row 8 from 8·6: Mario's, seen in the emulator) ----
{
  const at = (first: number, count: number) => {
    const s = slotOf(0x18, 0, 1);
    setRotationRange(s, first, count);
    const l = emptyList();
    l.slots.set(0, s);
    writeLevelList(rom, LEVEL, l);
    emu.load(LEVEL);
    return heldColors(emu.animationFrames(count + 1, 8).map((f) => f.cgram), first, count, 'right', 1);
  };
  check(at(FIRST, N).length === 0, 'a range of the level\'s colors: none held');
  // equal colors side by side, fewer steps than a round: a color only ever passed by its equal is not held
  const cg = (v: number[]) => Uint8Array.from(v.flatMap((c) => [c & 0xff, c >> 8]));
  check(heldColors([cg([1, 1, 1, 2]), cg([2, 1, 1, 1])], 0, 4, 'right', 1).length === 0, 'equal neighbours are not held');
  check(heldColors([cg([1, 2, 3]), cg([1, 1, 2])], 0, 3, 'right', 1).join() === '0', 'a color that stays though another comes: held');
  const held = at(0x83, 12);
  check(held.length > 0 && held.every((c) => c >= 0x86 && c <= 0x8f) && !held.includes(0x83), `row 8: held ${held.map((c) => c.toString(16)).join(' ')}`);
}

// ---- the period of a list ----
{
  const l = emptyList();
  check(exanimPeriod([l]) === 1, 'empty list: 1 step');
  l.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 3, dest: 0x8600, frames: [0, 0x20, 0x40, 0x60] });
  check(exanimPeriod([l]) === 4, 'four frames: 4 steps');
  l.slots.set(1, slotOf(0x18, 0, 2)); // 5 colors, every 2 steps: 10
  check(exanimPeriod([l]) === 20, `with a rotation of 5 colors, delay 2: 20 steps (${exanimPeriod([l])})`);
  l.slots.set(2, slotOf(0x18, 3, 1)); // waiting: counted as running (the trigger may hold)
  check(exanimPeriod([l]) === 20, 'a rotation of the same length does not change it');
  check(exanimPeriod([l], 16) === 16, 'capped');
  check(exanimPeriod([l], 64, 8) === 40 && exanimPeriod([emptyList()], 64, 8) === 8, 'a multiple of the base');
}

console.log(bad ? `${bad} failures` : 'rotation ok');
if (bad) process.exit(1);
