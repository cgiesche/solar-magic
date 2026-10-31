// Layer 2 scroll rates. The game pairs a horizontal and a vertical rate in one setting (secondary
// header $05F000 bits 7-4). Lunar Magic 3.40 added separate rates and more of them, in a byte per
// level at $06FA00, SHCVVVVV (format observed in a Lunar Magic-saved ROM, see docs/patches.md):
//  - S: separate rates; the header's 4 bits are then the horizontal rate, V the vertical one
//  - H: the horizontal rate is an auto-scroll (0-5 left, 6-B right, Slow … Fast 4)
//  - C: Lunar Magic's "auto-set number of screens" (an editor option, not read by the game; kept)
//  - V: rates 0-8 as the horizontal ones, 10-15 auto-scroll up, 16-1B down
// The editor's patch (L2SCROLL_ASM) runs the game's own code while both rates are ones the game knows
// (horizontal 0-2, vertical 0-3, which mean the same there): every level without S, unchanged.
//
// What a setting does is found by letting the level run (layer2Motion): how far layer 2 moves while
// the camera moves, and how far it moves while the camera stands still.

import type { Rom } from './rom.ts';
import type { LevelEmulator, LevelOverride } from './levelemu.ts';
import { L1_PTRS, L2_PTRS, encodeSecondaryHeader, decodeSecondaryHeader, readSecondaryHeader, type SecondaryHeader } from './level.ts';
import type { RomReads } from './romdeps.ts';
import { GM, RAM, get16, setMarioPos, setCameraX, setCameraY } from './ram.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { installEditorPatch } from './patches.ts';

export const L2_SCROLL_TABLE = 0x06fa00;
export const L2_SCROLL_PATCH_NAME = 'Layer 2 scroll rates (Lunar Magic format)';
export const L2_SCROLL_RAM: [number, number] = [0x7f3660, 6];
const LOAD_HOOK = 0x05d915, SCROLL_HOOK = 0x00f79d;

// At the level load the game takes both rates from its pairs ($05D720 horizontal, $05D710
// vertical, into $1413/$1414); with S the patch puts the level's own there: rates 0-8 as they are,
// horizontal auto-scrolls as $10-$1B like the vertical ones. Each frame, after the camera
// ($00F79D), layer 2 follows layer 1 at its rate; an auto-scroll follows it 1:1 and moves on by
// itself while the game runs ($9D clear), in 1/256 pixels. Vertically the game's offset $1417 is
// added, as the game does.
export const L2SCROLL_ASM = `asar 1.90
lorom
!HAcc = $${L2_SCROLL_RAM[0].toString(16).toUpperCase()}        ; auto-scroll distance: 1/256 pixels, then pixels (3 bytes each)
!VAcc = !HAcc+3
!Table = $${L2_SCROLL_TABLE.toString(16).toUpperCase()}

org !Table
  fillbyte $00 : fill 512

org $${LOAD_HOOK.toString(16).toUpperCase()}   ; LDA $05D720,x : STA $1413 : LDA $05D710,x : STA $1414 (A 8, X/Y 16, Y = level)
  JSL Load
  NOP #10

org $${SCROLL_HOOK.toString(16).toUpperCase()}   ; LDY $1413 : BEQ (A 16, X/Y 8)
  JML Scroll
  NOP

freecode
Load:
  LDA.l $05D720,x : STA $1413
  LDA.l $05D710,x : STA $1414
  PHX
  TYX
  LDA.l !Table,x
  BPL .paired
  AND #$1F : STA $1414
  LDA.l !Table,x
  PLX
  PHX
  ASL : ASL         ; H to carry
  TXA : AND #$0F
  BCC +
  ORA #$10
+ STA $1413
.paired
  PLX
  LDA #$00
  STA.l !HAcc : STA.l !HAcc+1 : STA.l !HAcc+2
  STA.l !VAcc : STA.l !VAcc+1 : STA.l !VAcc+2
  RTL

Scroll:
  LDY $1413
  CPY #$03 : BCS .own
  LDY $1414
  CPY #$04 : BCS .own
  LDY $1413
  BNE +
  JML $80F7AA
+ JML $80F7A2
.own
  LDY $1413
  LDA $1A
  JSR Rate
  BCC +
  CLC : ADC.l !HAcc+1
  STA $1E
  LDY $1413
  LDX #$00
  JSR Auto
  BRA ++
+ BEQ ++
  STA $1E
++
  LDY $1414
  LDA $1C
  JSR Rate
  BEQ .done
  BCC +
  CLC : ADC.l !VAcc+1
  PHA
  LDY $1414
  LDX #$03
  JSR Auto
  PLA
+ CLC : ADC $1417
  STA $20
.done
  JML $80F7C2

; A = the layer 1 position, Y = the rate: A = layer 2's position (Z: none; C: an auto-scroll)
Rate:
  CPY #$10 : BCS .auto
  CPY #$09 : BCS .none
  PHA
  TYA : ASL : TAX
  PLA
  JMP (.rates,x)
.rates
  dw .none, .one, .r2, .r32, .r4, .r8, .r16, .r64, .fast
.r64
  LSR
.r32
  LSR
.r16
  LSR
.r8
  LSR
.r4
  LSR
.r2
  LSR
.one
  REP #$02 : CLC   ; Z clear: a rate (a position of 0 too)
  RTS
.fast               ; 6/5
  STA $4204 : PHA
  SEP #$20 : LDA #$05 : STA $4206 : REP #$20
  PLA : NOP #4      ; the division takes 16 cycles
  CLC : ADC $4214
  REP #$02 : CLC
  RTS
.auto
  CPY #$1C : BCS .none
  REP #$02 : SEC
  RTS
.none
  SEP #$02 : CLC
  RTS

; moves the auto-scroll of rate Y (X = 0 horizontal, 3 vertical) on by one frame, unless the game is
; paused (A 16)
Auto:
  LDA $9D : AND #$00FF : BNE .done
  PHB : PHK : PLB
  TYA : SEC : SBC #$0010 : AND #$00FF
  CMP #$0006 : PHP          ; C: right/down, the position shrinks
  BCC +
  SBC #$0006
+ ASL : TAY
  LDA .speeds,y
  PLP
  BCC .grow
  EOR #$FFFF : INC
  LDY #$FF
  BRA +
.grow
  LDY #$00
+ PLB
  CLC : ADC.l !HAcc,x : STA.l !HAcc,x
  SEP #$20
  TYA : ADC.l !HAcc+2,x : STA.l !HAcc+2,x
  REP #$20
.done
  RTS
.speeds
  dw $0040, $0080, $0100, $0200, $0300, $0400
`;

export function l2ScrollEntry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'l2scroll') ?? null;
}

// needs Asar (loadAsar) to be loaded
export function installL2ScrollPatch(rom: Rom): ApplyResult {
  const e = l2ScrollEntry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  installEditorPatch(rom);
  return applyPatch(rom, { name: L2_SCROLL_PATCH_NAME, main: 'l2scroll.asm', files: new Map([['l2scroll.asm', L2SCROLL_ASM]]), kind: 'l2scroll', ram: [L2_SCROLL_RAM] });
}

// how layer 2 moves in one direction: layer 2 pixels per layer 1 pixel, and pixels per frame by itself
// (positive: the layer's position grows, the drawn layer moves left/up)
export interface Motion { rate: number; drift: number }
export interface LayerMotion { x: Motion; y: Motion }

const STILL = 64, MOVE = 128;
const VERTICAL_MODE = 0x0a; // the measuring level is vertical: room for the camera in both directions

const d16 = (a: number, b: number) => (((b - a) << 16) >> 16);

// The level with its settings (ov: its secondary header and code) on an empty vertical layer 1 of 16
// screens, without sprites; Mario is held in the air and moved, the camera follows him.
export function layer2Motion(emu: LevelEmulator, level: number, ov: LevelOverride): LayerMotion {
  const rom = emu.rom, l1 = ov.layer1 ?? rom.bytes(rom.r24(L1_PTRS + level * 3), 5);
  const hdr = [(l1[0] & 0xe0) | 0x0f, (l1[1] & 0xe0) | VERTICAL_MODE, l1[2], l1[3], l1[4]];
  const r = emu.load(level, {
    ...ov, layer1: new Uint8Array([...hdr, 0xff]), layer2: undefined, bgData: undefined, layer2Pointer: rom.r24(L2_PTRS + 0x105 * 3),
    sprites: new Uint8Array([0, 0xff]), byteOwner: undefined,
  });
  const none: LayerMotion = { x: { rate: 0, drift: 0 }, y: { rate: 0, drift: 0 } };
  if (!r.ok) return none;
  const s = emu.snes, w = s.wram;
  let mx = 0x80, my = 0x300;
  setCameraX(w, mx - 0x70); setCameraY(w, my - 0x70);
  const frame = (dx: number, dy: number) => {
    mx += dx; my += dy;
    setMarioPos(w, mx, my);
    w[RAM.marioSpeedX] = 0; w[RAM.marioSpeedY] = 0; w[RAM.hurtTimer] = 0x40;
    w[RAM.scrollH] = 1; w[RAM.scrollV] = 1; w[RAM.scrollUp] = 1; // the camera follows him either way
    s.runFrame();
  };
  for (let f = 0; f < 200 && w[RAM.gameMode] !== GM.level; f++) frame(0, 0);
  for (let f = 0; f < 16; f++) frame(0, 0);
  const at = () => [get16(w, RAM.layer1X), get16(w, RAM.layer1Y), get16(w, RAM.layer2X), get16(w, RAM.layer2Y)];
  const a = at();
  for (let f = 0; f < STILL; f++) frame(0, 0);
  const b = at();
  for (let f = 0; f < MOVE; f++) frame(1, 2);
  const c = at();
  if (w[RAM.gameMode] !== GM.level) return none;
  const motion = (i: number): Motion => {
    const drift = d16(a[i + 2], b[i + 2]) / STILL, l1 = d16(b[i], c[i]);
    return { drift, rate: l1 ? (d16(b[i + 2], c[i + 2]) - drift * MOVE) / l1 : 0 };
  };
  return { x: motion(0), y: motion(1) };
}

// The separate rates, the same values for both directions as the header dialog offers them: 0-8,
// then the auto-scrolls $10-$1B (horizontally the header's 4 bits with H set).
export const RATE_OPTIONS = [...Array(9).keys(), ...Array.from({ length: 12 }, (_, i) => 0x10 + i)];
export const hRate = (s: SecondaryHeader) => (s.layer2HAuto ? 0x10 | s.layer2Scroll : s.layer2Scroll);
export function withRates(s: SecondaryHeader, h: number, v: number): SecondaryHeader {
  return { ...s, layer2Separate: 1, layer2Scroll: h & 0x0f, layer2HAuto: h >= 0x10 ? 1 : 0, layer2V: v };
}

export interface Layer2Motions {
  paired: LayerMotion[]; // the game's 16 settings
  separate: LayerMotion[]; // RATE_OPTIONS, each in both directions at once
}

// every setting measured (layer2Motion) in the level with its code (ov); yields between the settings
export function* layer2MotionsJob(emu: LevelEmulator, level: number, ov: LevelOverride): Generator<void, { result: Layer2Motions; reads: RomReads }> {
  const sec = ov.secondaryHeader ? decodeSecondaryHeader(ov.secondaryHeader) : readSecondaryHeader(emu.rom, level);
  let reads: RomReads | null = null;
  const measure = (s: SecondaryHeader) => {
    const r = emu.tracked(() => layer2Motion(emu, level, { ...ov, secondaryHeader: encodeSecondaryHeader(s) }));
    if (reads) reads.add(r.reads); else reads = r.reads;
    return r.result;
  };
  const result: Layer2Motions = { paired: [], separate: [] };
  for (let p = 0; p < 16; p++) { result.paired.push(measure({ ...sec, layer2Separate: 0, layer2Scroll: p })); yield; }
  for (const v of RATE_OPTIONS) { result.separate.push(measure(withRates(sec, v, v))); yield; }
  return { result, reads: reads! };
}

// what a motion looks like: "fixed", "1:1", "1/4", "1.2×", "1:1, up 0.25 px/frame"
export function motionText(m: Motion, axis: 'x' | 'y'): string {
  const rate = m.rate < 0.005 ? 'fixed' : m.rate > 0.95 && m.rate < 1.05 ? '1:1'
    : m.rate > 1 ? `${Math.round(m.rate * 10) / 10}×` : `1/${2 ** Math.round(Math.log2(1 / m.rate))}`;
  if (Math.abs(m.drift) < 0.01) return rate;
  const dir = axis === 'x' ? (m.drift > 0 ? 'left' : 'right') : (m.drift > 0 ? 'up' : 'down');
  return `${rate}, ${dir} ${Math.round(Math.abs(m.drift) * 100) / 100} px/frame`;
}
