// ExAnimation triggers (Lunar Magic's, LM help: level_ex20.htm, view_exanimation.htm): the editor's model
// of them (extrigger.ts) against what the engine does in the emulator – Trigger Init (the global list's,
// then the level's), the view's triggers set after the load (custom, manual frames, one-shots, the game's
// conditions), the precision timer sharing a counter; the RAM and ASM shown; the problems found.
import { LevelEmulator } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { emptyList, writeLevelList, writeGlobalList, writeAltFile, readLevelList, triggerName, secondSet, type ExList, type ExSlot } from '../src/core/exanim.ts';
import {
  emptyTriggerView, initTriggers, setCustomInit, customInit, usedTriggers, triggerProblems, triggerRam, triggersFor, maxFrames, switchOf,
  EXTRIGGER_RAM, type TriggerView,
} from '../src/core/extrigger.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
const rom = new Rom((await editorImage()).slice());
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const emu = new LevelEmulator(rom);
emu.boot();
const LEVEL = 0x105;
// VRAM tiles the game's own animation leaves alone
const T0 = 0xa0, T1 = 0xa1, T2 = 0xa2, T3 = 0xa3;
const W = (a: number) => a - 0x7e0000; // WRAM offset of a long address

// frames of the animation file: tile k is filled with byte 0x10 + k
const alt = new Uint8Array(0x400);
for (let k = 0; k < 0x20; k++) alt.fill(0x10 + k, k * 32, k * 32 + 32);
writeAltFile(rom, 0, alt);
const tileByte = (v: Uint8Array, t: number) => v[t * 32];
// a tile slot on VRAM tile `t` (4bpp, layer 1/2 base 0) with frames = animation file tiles
// (a trigger with a second set: the first half normally, the second while it holds)
const tiles = (t: number, trigger: number, frames: number[]): ExSlot => ({ type: 0x01, trigger, framesLess1: (secondSet(trigger) ? frames.length / 2 : frames.length) - 1, dest: 0x8000 | (t * 16), frames: frames.map((f) => f * 32) });
// the level with a list, loaded with a view; the byte of tile t every 8 frames
function play(list: ExList, t: number, view: TriggerView | undefined, steps = 8): number[] {
  writeLevelList(rom, LEVEL, list);
  emu.load(LEVEL, { timer: 3, exTriggers: view });
  return emu.animationFrames(steps, 8).map((f) => tileByte(f.vram, t));
}
const listOf = (...slots: [number, ExSlot][]) => { const l = emptyList(); for (const [n, s] of slots) l.slots.set(n, s); return l; };

// ---- names, choices, limits ----
check(triggerName(0x06) === 'Time below 100 (one shot)' && triggerName(0x08) === '5 Dragon Coins (one shot)' && triggerName(0x0f) === 'Precision timer', 'the one-shot game triggers and the precision timer are named as in Lunar Magic');
check(triggersFor('tiles').includes(0x2f) && triggersFor('tiles').includes(0x4f) && triggersFor('tiles').includes(0x1f) && triggersFor('tiles').includes(0x0f), 'tiles: custom, one-shot, manual and the precision timer to choose');
check(!triggersFor('rotation').some((t) => t >= 0x10 && t < 0x20) && !triggersFor('rotation').some((t) => t >= 0x30) && triggersFor('rotation').includes(0x25) && triggersFor('rotation').includes(0x0f), 'rotations: no manual or one-shot triggers (the engine has none for them), custom and precision');
check(maxFrames(0x30) === 0xff && maxFrames(0x06) === 0xff && maxFrames(0x20) === 0x80 && maxFrames(0x10) === 0x100, 'frames: 0xFF for one-shots, 0x80 with a second set, else 0x100');
check(switchOf(0x06) === 0x05 && switchOf(0x08) === 0x07 && switchOf(0x00) === null && switchOf(0x0f) === null, 'the one-shot game triggers switch with their condition');

// ---- RAM and ASM ----
check(triggerRam(0x29)?.asm === 'LDA $7FC0FC : ORA #$0200 : STA $7FC0FC', `custom 9: Lunar Magic's example (${triggerRam(0x29)?.asm})`);
check(triggerRam(0x31)?.asm === 'LDA $7FC0F8 : ORA #$0002 : STA $7FC0F8' && triggerRam(0x42)?.asm === 'LDA $7FC0FA : ORA #$0004 : STA $7FC0FA', 'one-shot 01 and 12');
check(triggerRam(0x14)?.asm === 'LDA #$02 : STA $7FC074' && triggerRam(0x14)?.ram === '$7FC074', 'manual 4');
check(triggerRam(0x04)?.ram === '$1490' && triggerRam(0x00) === null, 'star: the game\'s RAM; always: none');

// ---- Trigger Init: the global list's, then the level's (it overrides) ----
{
  const g = emptyList(), l = emptyList();
  setCustomInit(g, 0, 'on'); setCustomInit(g, 1, 'on'); setCustomInit(g, 2, 'on');
  g.manual.set(2, 3); g.manual.set(5, 1);
  setCustomInit(l, 1, 'off'); setCustomInit(l, 7, 'on');
  l.manual.set(2, 1); l.manual.set(4, 0);
  check(customInit(g, 0) === 'on' && customInit(l, 1) === 'off' && customInit(l, 0) === 'keep', 'custom init states read back');
  const model = initTriggers(g, l);
  check(model.custom === 0b10000101 && model.manual.get(2) === 1 && model.manual.get(5) === 1 && model.manual.get(4) === 0, `the model: custom ${model.custom.toString(2)}, manual 2 from the level`);
  writeGlobalList(rom, g);
  writeLevelList(rom, LEVEL, l);
  check(readLevelList(rom, LEVEL)?.customKeep === l.customKeep, 'an init-only list is kept');
  const w = emu.load(LEVEL).wram;
  const custom = w[W(EXTRIGGER_RAM.custom)] | (w[W(EXTRIGGER_RAM.custom) + 1] << 8);
  const manual = [...model.manual].every(([n, f]) => w[W(EXTRIGGER_RAM.manual) + n] === f);
  check(custom === model.custom && manual, `the engine after the load: custom ${custom.toString(2)}, manual frames as the model`);
  writeGlobalList(rom, null);
}

// ---- the view's triggers, set after the load ----
{
  // custom 5 with a second set: 2 frames normally (1, 2), 2 while it holds (3, 4)
  const l = listOf([0, tiles(T0, 0x25, [1, 2, 3, 4])]);
  setCustomInit(l, 5, 'on');
  const init = play(l, T0, undefined);
  const v = emptyTriggerView(); v.custom.set(5, false);
  const off = play(l, T0, v);
  check(init.every((b) => b === 0x13 || b === 0x14) && off.every((b) => b === 0x11 || b === 0x12), `custom 5: on by the init (${init.map((b) => b.toString(16))}), off in the view (${off.map((b) => b.toString(16))})`);
}
{
  // manual 2, frames 1-3: the frame the view sets, nothing else
  const l = listOf([0, tiles(T0, 0x12, [1, 2, 3])]);
  for (const f of [0, 2]) {
    const v = emptyTriggerView(); v.manual.set(2, f);
    const s = play(l, T0, v);
    check(s.every((b) => b === 0x11 + f), `manual 2 at frame ${f}: ${s.map((b) => b.toString(16))}`);
  }
}
{
  // one-shot 03, frames 1-3: holds until fired, then plays once and stays on the last; the bit is cleared
  const l = listOf([0, tiles(T0, 0x33, [1, 2, 3])]);
  emu.snes.wram[0x0f31] = 0; // (as a level with time 000 leaves it)
  const idle = play(l, T0, undefined);
  const v = emptyTriggerView(); v.oneShot.add(3);
  const fired = play(l, T0, v);
  const bit = emu.snes.wram[W(EXTRIGGER_RAM.oneShot)] & 0x08;
  check(idle.every((b) => b < 0x11 || b > 0x13), `one-shot 03 waits (${idle.map((b) => b.toString(16))})`);
  // (the first frame may show during the fade-in already)
  const inOrder = fired.every((b, i) => b >= 0x11 && b <= 0x13 && (!i || b >= fired[i - 1]));
  check(inOrder && fired.slice(2).every((b) => b === 0x13) && !bit, `fired: in order to the last frame, stays there, the bit cleared (${fired.map((b) => b.toString(16))})`);
}
{
  // the game's conditions: star, time below 100 (its one-shot too), 5 Dragon Coins
  for (const [t, name] of [[0x04, 'star'], [0x05, 'time below 100'], [0x07, '5 Dragon Coins']] as const) {
    const l = listOf([0, tiles(T0, t, [1, 2, 3, 4])]);
    const v = emptyTriggerView(); v.game.add(t);
    const off = play(l, T0, undefined), on = play(l, T0, v); // (off: the level's start, its time 300)
    check(off.every((b) => b === 0x11 || b === 0x12) && on.every((b) => b === 0x13 || b === 0x14), `${name}: the second set while it holds in the view (${on.map((b) => b.toString(16))})`);
  }
  const l = listOf([0, tiles(T0, 0x06, [1, 2])]);
  const v = emptyTriggerView(); v.game.add(0x05);
  const once = play(l, T0, v);
  check(once.at(-1) === 0x12 && once.at(-2) === 0x12, `time below 100 (one shot): plays once (${once.map((b) => b.toString(16))})`);
  // with the level's time (300) it waits from the load on: the engine's eight setup frames (GM 12) run
  // after the editor sets it, even from a timer of 000
  emu.snes.wram[0x0f31] = 0; // (as a level with time 000 leaves it)
  const idle = play(l, T0, undefined);
  check(idle.every((b) => b < 0x11 || b > 0x12) && emu.snes.wram[W(EXTRIGGER_RAM.counters)] === 0xff, `time below 100 (one shot): not started during the load (${idle.map((b) => b.toString(16))})`);
}

// ---- the precision timer: the counter of the first slot of its 8 ----
{
  // slot 0 always, slot 4 with the precision timer: both move slot 0's counter, slot 4's stays $FF
  const l = listOf([0, tiles(T0, 0x00, [1, 2, 3, 4, 5, 6, 7, 8])], [4, tiles(T1, 0x0f, [1, 2, 3, 4, 5, 6, 7, 8])]);
  writeLevelList(rom, LEVEL, l);
  emu.load(LEVEL);
  const counters = (w: Uint8Array) => [w[W(EXTRIGGER_RAM.counters)], w[W(EXTRIGGER_RAM.counters) + 4]];
  emu.animationFrames(1, 8);
  const a = counters(emu.snes.wram);
  emu.animationFrames(1, 8);
  const b = counters(emu.snes.wram);
  check(a[1] === 0xff && b[1] === 0xff && (b[0] - a[0] + 8) % 8 === 2, `slot 4 shares slot 0's counter: it moves by 2 per 8 frames (${a} → ${b})`);
  // a rotation with it runs (it waits for no trigger)
  const r: ExSlot = { type: 0x18, trigger: 0x0f, framesLess1: 0, dest: 0x0321, frames: [] };
  writeLevelList(rom, LEVEL, listOf([0, r]));
  emu.load(LEVEL);
  const cg = emu.animationFrames(3, 8).map((f) => f.cgram[0x42] | (f.cgram[0x43] << 8));
  check(new Set(cg).size > 1, `a rotation with the precision timer turns (${cg.map((c) => c.toString(16))})`);
}

// ---- what the level uses, and its problems ----
{
  const l = listOf([0, tiles(T0, 0x33, [1, 2])], [1, tiles(T1, 0x25, [1, 2])], [2, tiles(T2, 0x06, [1])]);
  l.manual.set(3, 0xff);
  const g = listOf([5, tiles(T3, 0x33, [1])]);
  setCustomInit(g, 9, 'on');
  const used = usedTriggers(l, g);
  check(used.get(0x33)?.length === 2 && used.get(0x25)?.[0].slot === 1 && used.get(0x05)?.[0].slot === 2 && used.has(0x13) && used.has(0x29), `used: one-shot 03 twice, custom 5, timer (one shot), manual 3 and custom 9 by their init (${[...used.keys()].map((t) => t.toString(16))})`);
  const big: ExSlot = { type: 0x01, trigger: 0x34, framesLess1: 0xff, dest: 0x8640, frames: Array(0x100).fill(0) };
  l.slots.set(3, big);
  const p = triggerProblems(l, g).map((x) => x.text);
  check(p.some((x) => x.includes('One-Shot 03') && x.includes('2 slots')), 'a one-shot in two slots (level and global) is a problem');
  check(p.some((x) => x.includes('Manual 3') && x.includes('FF')), 'a manual init frame FF is a problem');
  check(p.some((x) => x.includes('256 frames')), 'a one-shot slot of 0x100 frames is a problem');
  check(triggerProblems(listOf([0, tiles(T0, 0x33, [1])]), null).length === 0, 'none in a plain list');
  const m = listOf([0, tiles(T0, 0x13, [1, 2])]);
  m.manual.set(3, 2);
  check(triggerProblems(m, null).some((x) => x.text.includes('Manual 3') && x.text.includes('only 2 frames')), 'a manual init frame past a slot\'s last is a problem');
  const r = listOf([0, { type: 0x18, trigger: 0x31, framesLess1: 0, dest: 0x0321, frames: [] }]);
  const pt = listOf([0, tiles(T0, 0x00, [1, 2, 3, 4])], [4, tiles(T1, 0x0f, [1, 2])]);
  check(triggerProblems(pt, null).some((x) => x.text.includes('precision timer') && x.text.includes('4, 2')), 'precision timer slots sharing a counter with different frame counts are a problem');
  pt.slots.set(4, tiles(T1, 0x0f, [1, 2, 3, 4]));
  check(triggerProblems(pt, null).length === 0, 'with the same frame count they are not');
  check(triggerProblems(r, null).some((x) => x.text.includes('only while Custom 1 is on')), 'a rotation with a one-shot trigger is a problem (the engine reads a custom bit)');
  const rm = listOf([0, { type: 0x19, trigger: 0x13, framesLess1: 0, dest: 0x0321, frames: [] }], [1, { type: 0x18, trigger: 0x13, framesLess1: 0, dest: 0x0331, frames: [] }]);
  const pm = triggerProblems(rm, null).map((x) => x.text);
  check(pm.some((x) => x.includes('level 00') && x.includes('always turns')) && pm.some((x) => x.includes('level 01') && x.includes('never turns')), 'a rotation with a manual trigger: 19 always turns, 18 never');
  // an overworld list (#261): manual 18–1F read the bytes of Event Manual 8–F (triggers 01–08), the submap's and
  // the overworld's global list alike
  const os = listOf([2, tiles(T0, 0x19, [1, 2])]), og = listOf([4, tiles(T1, 0x02, [1, 2])]);
  const po = triggerProblems(os, og, true).filter((x) => x.text.includes('Event Manual 9'));
  check(po.length === 1 && po[0].slots.length === 2 && po[0].slots.some((r) => !r.global && r.slot === 2) && po[0].slots.some((r) => r.global && r.slot === 4), `overworld: Manual 9 with trigger 02 (Event Manual 9) is a problem (${po.map((x) => x.text).join(' | ')})`);
  check(!triggerProblems(os, listOf([4, tiles(T1, 0x03, [1, 2])]), true).some((x) => x.text.includes('Event Manual')), 'not with another event trigger (03: Event Manual A)');
  check(!triggerProblems(os, og, false).some((x) => x.text.includes('Event Manual')), 'not in a level (02 is the silver P-switch there)');
  // as the engine does it
  writeLevelList(rom, LEVEL, rm);
  emu.load(LEVEL);
  const fr = emu.animationFrames(3, 8), c16 = (cg: Uint8Array, k: number) => cg[2 * k] | (cg[2 * k + 1] << 8);
  const turns = fr.map((f) => [c16(f.cgram, 0x21), c16(f.cgram, 0x31)]);
  const distinct = new Set([0x31, 0x32, 0x33, 0x34].map((k) => c16(fr[0].cgram, k))).size > 1; // (else no turn would show)
  check(new Set(turns.map((t) => t[0])).size > 1 && distinct && new Set(turns.map((t) => t[1])).size === 1, `in the engine: 19 with a manual trigger turns, 18 does not (${turns.map((t) => t.map((c) => c.toString(16)).join('/'))})`);
}

console.log(bad ? `${bad} failures` : 'triggers ok');
if (bad) process.exit(1);
