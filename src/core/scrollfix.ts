// The sprite scroll fix, after HammerBrother's "Sprite Scroll Fix" (SMW Central 13675/40600). The game
// sets $55/$56, the side new tiles and sprites load on, by where Mario is on the screen ($00F721,
// $00F805), and not at all while the camera doesn't follow him ($1411/$1412 clear). Code moving the
// camera itself ($1462/$1464: auto-scrolls, scrolling pipes, UberASM) then has sprites spawn on the
// wrong side or not at all. The patch sets $55/$56 by the way the camera really moved since the frame
// before, kept as it is while it stands still.
//
// The original guards against ROMs without Lunar Magic's VRAM patch (its setting at $0FFFE6), which its
// code doesn't need (the newer release reads Lunar Magic's previous camera position at $7F831F instead
// of its own RAM); here it is an editor patch with its own RAM, and the original a replaced patch
// (replaced.ts).

import type { Rom } from './rom.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { SCROLL_FIX_RAM } from './ram.ts';

export const SCROLL_FIX_PATCH_NAME = 'Sprite scroll fix (HammerBrother)';
const hx = (v: number) => v.toString(16).toUpperCase();

const SCROLL_FIX_ASM = `asar 1.90
lorom
!Prev = $${hx(SCROLL_FIX_RAM[0])}   ; the camera's position the frame before: X, Y (16-bit each)

org $00F713   ; LDY $1411 : BEQ (A 16, X/Y 8; horizontal levels)
  JML ScrollX
  NOP

org $00F728   ; STY $55 : STY $56 by Mario's place on the screen
  BRA + : NOP #2 : +

org $00F7F4   ; LDX $1412 : BNE (A 16, X/Y 8; JSR'd)
  JML ScrollY
  NOP

org $00F80C   ; STY $55 : STY $56 by Mario's place on the screen
  BRA + : NOP #2 : +

freecode
ScrollX:
  LDX #$00 : JSR Direction
  LDY $1411 : BEQ +
  JML $00F718
+ JML $00F79D           ; (the game's BEQ to a BRA there)

ScrollY:
  LDX #$02 : JSR Direction
  LDX $1412 : BNE +
  JML $00F7F9           ; its RTS
+ JML $00F7FA

; X = 0 horizontally, 2 vertically: $55/$56 = 0 when the camera moved left/up, 2 right/down
Direction:
  PHA
  LDA $1462,x
  CMP.l !Prev,x : BEQ .still
  BPL .ahead
  LDA #$0000 : BRA +
.ahead
  LDA #$0202
+ STA $55
  LDA $1462,x : STA.l !Prev,x
.still
  PLA
  RTS
`;

export function scrollFixEntry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'scrollfix') ?? null;
}

// needs Asar (loadAsar) to be loaded
export function installScrollFixPatch(rom: Rom): ApplyResult {
  const e = scrollFixEntry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  return applyPatch(rom, { name: SCROLL_FIX_PATCH_NAME, main: 'scrollfix.asm', files: new Map([['scrollfix.asm', SCROLL_FIX_ASM]]), kind: 'scrollfix', ram: [SCROLL_FIX_RAM] });
}
