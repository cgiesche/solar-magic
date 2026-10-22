// ExAnimation triggers (Lunar Magic's, LM help: level_ex20.htm, view_exanimation.htm): what makes a slot run.
// The game's conditions (P-switches, ON/OFF, star, time below 100, 5 Dragon Coins; the last two also as
// one-shots that play once), the precision timer (a slot sharing the counter of the first slot of its 8), and
// those community code sets in the engine's RAM (EXTRIGGER_RAM): manual 0-F (the frame to show, a byte each),
// custom 0-F (bits, a second frame set while on) and one-shot 00-1F (bits; the slot plays once and the engine
// clears the bit). A list's Trigger Init sets custom triggers and manual frames when the level loads, the
// global list's first, then the level's over them.
//
// The view switches triggers after the level's load (applyTriggers, LevelOverride.exTriggers): the engine
// then runs as in the game.

import { kindOf, secondSet, triggerName, reversesOnTrigger, type ExList, type SlotKind } from './exanim.ts';
import { RAM, EXTRIGGER_RAM } from './ram.ts';

export { EXTRIGGER_RAM };
export const MANUAL = 0x10, CUSTOM = 0x20, ONE_SHOT = 0x30, PRECISION = 0x0f;

const GAME_HOLDS = [0x03, 0x01, 0x02, 0x04, 0x05, 0x07]; // ON/OFF, P-switches, star, time, coins
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

// the triggers a slot of a kind can take, in the order offered: rotations neither show frames once nor
// manually (the engine has no such trigger for them: triggerProblems)
export function triggersFor(kind: SlotKind): number[] {
  if (kind === 'rotation') return [0x00, ...GAME_HOLDS, PRECISION, ...range(CUSTOM, 16)];
  return [0x00, ...GAME_HOLDS, 0x06, 0x08, PRECISION, ...range(MANUAL, 16), ...range(CUSTOM, 16), ...range(ONE_SHOT, 32)];
}

export const isManual = (t: number) => t >= MANUAL && t < CUSTOM;
export const isCustom = (t: number) => t >= CUSTOM && t < ONE_SHOT;
export const isOneShot = (t: number) => t >= ONE_SHOT && t < ONE_SHOT + 32;
// the slot runs through its frames once when the trigger fires, then stays on the last
export const playsOnce = (t: number) => t === 0x06 || t === 0x08 || isOneShot(t);
// most frames a slot can have with the trigger: the engine's 8-bit count runs once to 0xFF at most
export function maxFrames(t: number): number {
  return playsOnce(t) ? 0xff : secondSet(t) ? 0x80 : 0x100;
}

// what the view switches for a trigger: the game's condition (a one-shot one by its condition), a manual,
// custom or one-shot trigger itself; null for those that need no switch (always, the precision timer,
// the reserved ones)
export function switchOf(t: number): number | null {
  if (t === 0x06) return 0x05;
  if (t === 0x08) return 0x07;
  if (GAME_HOLDS.includes(t) || t >= MANUAL && t < ONE_SHOT + 32) return t;
  return null;
}

const hx = (v: number, n: number) => v.toString(16).toUpperCase().padStart(n, '0');
// a switch's name (the game's one-shot conditions switch with their condition)
export const switchName = (sw: number) => ({ 0x03: 'ON/OFF switch OFF', 0x05: 'Time below 100', 0x07: '5 Dragon Coins' } as Record<number, string>)[sw] ?? triggerName(sw);
// every switch the view can set: the game's conditions, manual, custom and one-shot triggers
export const ALL_SWITCHES = [...GAME_HOLDS, ...range(MANUAL, 16), ...range(CUSTOM, 16), ...range(ONE_SHOT, 32)];
const addr = (a: number) => `$${hx(a, a > 0xffff ? 6 : 4)}`;

// where a trigger lives in RAM, what it holds there, and an ASM line that sets it (16-bit A for the bits,
// as in Lunar Magic's help; 8-bit A for a manual frame); null for those without RAM
export function triggerRam(t: number): { ram: string; what: string; asm?: string; off?: string } | null {
  if (isManual(t)) {
    const a = addr(EXTRIGGER_RAM.manual + (t - MANUAL));
    return { ram: a, what: 'the frame to show (a byte, 00–FE); the slot uploads it when it changes', asm: `LDA #$02 : STA ${a}` };
  }
  if (isCustom(t) || isOneShot(t)) {
    const n = isCustom(t) ? t - CUSTOM : t - ONE_SHOT;
    const a = addr(isCustom(t) ? EXTRIGGER_RAM.custom : EXTRIGGER_RAM.oneShot + (n >> 4) * 2);
    const bit = 1 << (n & 15);
    return {
      ram: `${a} bit ${n & 15}`,
      what: isCustom(t) ? 'on while the bit is set (the second frame set shows)' : 'set it to play the slot once; the engine clears it at the end',
      asm: `LDA ${a} : ORA #$${hx(bit, 4)} : STA ${a}`, off: `LDA ${a} : AND #$${hx(~bit & 0xffff, 4)} : STA ${a}`,
    };
  }
  const game: Record<number, [number, string]> = {
    0x01: [RAM.blueP, 'the blue P-switch\'s timer (not 0)'], 0x02: [RAM.silverP, 'the silver P-switch\'s timer (not 0)'],
    0x03: [RAM.onOff, '1 = OFF'], 0x04: [RAM.starTimer, 'the star\'s timer (not 0)'],
    0x05: [RAM.timer, 'the timer\'s hundreds (0)'], 0x07: [RAM.dragonCoins, 'Dragon Coins collected (5 or more)'],
  };
  const g = game[switchOf(t) ?? -1];
  return g ? { ram: addr(g[0]), what: g[1] } : null;
}

// ---- Trigger Init (a list's custom triggers kept / set and manual frames, 16 bits each) ----
export type CustomInit = 'keep' | 'on' | 'off';
export function customInit(l: ExList, n: number): CustomInit {
  const bit = 1 << n;
  return l.customSet & bit ? 'on' : l.customKeep & bit ? 'keep' : 'off';
}
export function setCustomInit(l: ExList, n: number, v: CustomInit): void {
  const bit = 1 << n;
  l.customKeep = v === 'off' ? l.customKeep & ~bit : l.customKeep | bit;
  l.customSet = v === 'on' ? l.customSet | bit : l.customSet & ~bit;
}
// the triggers when the level has loaded, from `custom` before (the last level's; 0 after a reset): the
// global list's init, then the level's
export function initTriggers(global: ExList | null, level: ExList | null, custom = 0): { custom: number; manual: Map<number, number> } {
  const manual = new Map<number, number>();
  for (const l of [global, level]) {
    if (!l) continue;
    custom = (custom & l.customKeep) | l.customSet;
    for (const [n, f] of l.manual) manual.set(n, f);
  }
  return { custom: custom & 0xffff, manual };
}

// ---- the view's triggers ----
export interface TriggerView {
  game: Set<number>; // conditions that hold (switchOf: 1, 2, 4, 5, 7; ON/OFF is the view's own switch)
  custom: Map<number, boolean>; // custom n on or off, over the level's init
  oneShot: Set<number>; // one-shot n fired once the level has loaded
  manual: Map<number, number>; // manual n's frame, over the level's init
}
export function emptyTriggerView(): TriggerView {
  return { game: new Set(), custom: new Map(), oneShot: new Set(), manual: new Map() };
}
export const viewEmpty = (v: TriggerView) => !v.game.size && !v.custom.size && !v.oneShot.size && !v.manual.size;

// sets the view's triggers in the game's RAM (bank $7E from 0), after the level's load set its own: the
// game's conditions so that they hold for a while (the timers run down, the time below 100 counts on)
export function applyTriggers(w: Uint8Array, v: TriggerView): void {
  const W = (a: number) => a - 0x7e0000;
  if (v.game.has(0x01)) w[RAM.blueP] = 0xff;
  if (v.game.has(0x02)) w[RAM.silverP] = 0xff;
  if (v.game.has(0x04)) w[RAM.starTimer] = 0xff;
  if (v.game.has(0x05)) { w[RAM.timer] = 0; w[RAM.timer + 1] = 9; w[RAM.timer + 2] = 9; }
  if (v.game.has(0x07)) w[RAM.dragonCoins] = Math.max(5, w[RAM.dragonCoins]);
  const c = W(EXTRIGGER_RAM.custom);
  let custom = w[c] | (w[c + 1] << 8);
  for (const [n, on] of v.custom) custom = on ? custom | (1 << n) : custom & ~(1 << n);
  w[c] = custom & 0xff; w[c + 1] = custom >> 8;
  for (const n of v.oneShot) w[W(EXTRIGGER_RAM.oneShot) + (n >> 3)] |= 1 << (n & 7);
  for (const [n, f] of v.manual) w[W(EXTRIGGER_RAM.manual) + n] = f;
}

// whether custom trigger n is on in the game's RAM (bank $7E from 0)
export function customOn(w: Uint8Array, n: number): boolean {
  return !!(w[EXTRIGGER_RAM.custom - 0x7e0000 + (n >> 3)] & (1 << (n & 7)));
}

// ---- what a level uses ----
export type SlotRef = { global: boolean; slot: number };
export const slotName = (r: SlotRef) => `${r.global ? 'global' : 'level'} ${hx(r.slot, 2)}`;
// the switches (switchOf) the slots of the level's and the global list use, with their slots; custom
// triggers and manual frames a Trigger Init sets count too (without slots); ordered by switch
export function usedTriggers(level: ExList | null, global: ExList | null): Map<number, SlotRef[]> {
  const out = new Map<number, SlotRef[]>();
  const add = (t: number, ref?: SlotRef) => {
    let a = out.get(t);
    if (!a) out.set(t, a = []);
    if (ref) a.push(ref);
  };
  for (const [g, l] of [[false, level], [true, global]] as const) {
    if (!l) continue;
    for (const [slot, e] of [...l.slots].sort((a, b) => a[0] - b[0])) {
      const sw = switchOf(e.trigger);
      if (sw !== null && kindOf(e.type)) add(sw, { global: g, slot });
    }
    for (let n = 0; n < 16; n++) if (customInit(l, n) !== 'keep') add(CUSTOM + n);
    for (const n of l.manual.keys()) add(MANUAL + n);
  }
  return new Map([...out].sort((a, b) => a[0] - b[0]));
}

// ---- problems ----
export function triggerProblems(level: ExList | null, global: ExList | null): { text: string; slots: SlotRef[] }[] {
  const out: { text: string; slots: SlotRef[] }[] = [];
  // the same one-shot in several slots of the level (its own and the global ones run there)
  const shots = new Map<number, SlotRef[]>();
  // a manual trigger's slots: their fewest frames (the engine shows frame 0 for a frame past a slot's last)
  const manualFrames = new Map<number, number>();
  for (const l of [level, global]) for (const e of l?.slots.values() ?? []) {
    if (isManual(e.trigger)) manualFrames.set(e.trigger - MANUAL, Math.min(manualFrames.get(e.trigger - MANUAL) ?? 0x100, e.framesLess1 + 1));
  }
  for (const [g, l] of [[false, level], [true, global]] as const) {
    if (!l) continue;
    for (const [slot, e] of l.slots) {
      if (kindOf(e.type) === 'rotation' && (isManual(e.trigger) || isOneShot(e.trigger))) {
        // the engine's rotation takes a manual trigger for one that never holds, a one-shot for the custom
        // bit of its low 4 bits; 19 and 1B turn without it, the other way while it holds
        const reverses = reversesOnTrigger(e.type), c = `Custom ${hx((e.trigger - CUSTOM) & 15, 1)}`;
        const does = isManual(e.trigger) ? (reverses ? 'it always turns, never the other way' : 'it never turns')
          : reverses ? `it turns the other way while ${c} is on` : `it turns only while ${c} is on`;
        out.push({ text: `Slot ${slotName({ global: g, slot })} is a color rotation with ${triggerName(e.trigger)}: the engine has no manual or one-shot trigger for rotations – ${does}; choose a custom trigger`, slots: [{ global: g, slot }] });
      }
      if (isOneShot(e.trigger)) { const a = shots.get(e.trigger) ?? []; a.push({ global: g, slot }); shots.set(e.trigger, a); }
      if (playsOnce(e.trigger) && kindOf(e.type) !== 'rotation' && e.framesLess1 + 1 > 0xff) out.push({ text: `Slot ${slotName({ global: g, slot })} plays once (${triggerName(e.trigger)}) with 256 frames – at most 255: the engine never ends it`, slots: [{ global: g, slot }] });
    }
    for (const [n, f] of l.manual) if (f !== 0xff && f >= (manualFrames.get(n) ?? 0x100)) out.push({ text: `${g ? 'Global' : 'Level'} Trigger Init: Manual ${hx(n, 1)} starts at frame ${hx(f, 2)}, but a slot using it has only ${manualFrames.get(n)} frames – it shows frame 00 there`, slots: [] });
    for (const [n, f] of l.manual) if (f === 0xff) out.push({ text: `${g ? 'Global' : 'Level'} Trigger Init: Manual ${hx(n, 1)} starts at frame FF – the engine takes FF for “nothing shown yet”, so the frame never shows; choose 00–FE`, slots: [] });
    // the precision timer: its slots and the first of their 8 move one counter on, each at the frames it
    // has (from 0 again past its last), so with different frame counts they skip frames
    for (const first of [0x00, 0x08, 0x10, 0x18]) {
      const group = [...l.slots].sort((a, b) => a[0] - b[0]).filter(([n, e]) => n >= first && n < first + 8 && kindOf(e.type) && (n === first || e.trigger === PRECISION));
      if (!group.some(([n, e]) => n !== first && e.trigger === PRECISION) || !group.some(([, e]) => kindOf(e.type) !== 'rotation')) continue;
      const frames = new Set(group.map(([, e]) => e.framesLess1));
      if (frames.size > 1) out.push({ text: `Slots ${group.map(([slot]) => slotName({ global: g, slot })).join(', ')} share the counter of slot ${slotName({ global: g, slot: first })} (the precision timer), with different frame counts (${group.map(([, e]) => e.framesLess1 + 1).join(', ')}): each moves it on and back to 0 past its own last frame, so they skip frames`, slots: group.map(([slot]) => ({ global: g, slot })) });
    }
  }
  for (const [t, refs] of shots) if (refs.length > 1) out.push({ text: `${triggerName(t)} is used by ${refs.length} slots (${refs.map(slotName).join(', ')}): the first to finish turns it off and pauses the others`, slots: refs });
  return out;
}
