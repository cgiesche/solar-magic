// Graphics per submap, in Lunar Magic's layout (an editor patch, ADR 0004, in Lunar Magic's format, ADR 0005; issue #83).
//
// Palettes: the game builds a submap's colors from shared tables ($00AD25: $00B3D8, after the special world
// $00B732, and per submap a BG palette from $00ABDF); Lunar Magic (custom overworld palettes, 1.80) replaces that with
// all 256 colors of their own per submap – a JSL at $00AD32 (then RTS) to a routine that copies 0x200 bytes to the
// palette buffer $0703 from a table of 14 palettes (submaps 0–6, then 0–6 after the special world: $1EEB bit 7, the
// game's test), 0x200 bytes each, the submap from the low nibble of the tileset $1931 (0x11–0x17). The routine is
// Lunar Magic's byte for byte (as in the ROMs it saved), so tools reading the table's address there find it: the
// operand of its ADC (the table's low 16 bits) and its MVN's source bank. The game also loads the palette through it
// when Mario walks to another submap ($00A594 from $04DBAE).
// The colors the patch starts with are the game's own: its routine run while the overworld loads on each submap (as
// after loading a save, emulated), the 0x200 bytes of $0703 when it returns – colors it doesn't write are those the
// game had there then.

import { Rom, snesToPc } from './rom.ts';
import { assemble } from './asar.ts';
import { OverworldEmulator } from './overworld.ts';
import { RAM } from './ram.ts';

export const SUBMAPS = 7;
export const SUBMAP_PALETTE_SIZE = 0x200; // 256 colors, color 0 the back area color
export const SUBMAP_PALETTES = SUBMAPS * 2; // normal, then after the special world
const PAL_HOOK = 0x00ad32; // JSL routine : RTS
const PAL_RETURN = 0x00a150; // after the overworld load's JSR $AD25
const PAL_ROUTINE = 0x00ad25;
const ROUTINE_LEN = 35;
const ROUTINE_ADC = 18; // the ADC's operand: the table's low 16 bits
const ROUTINE_BANK = 30; // the MVN's source bank: the table's bank
// the special world passed: bit 7 of $1EEB (the game's LDA $1EEA in 16 bit, its sign: translevel 49's passed flag)
const SPECIAL_FLAG = RAM.levelFlags + 0x49;

const routineAsm = () => `lorom
org $${PAL_HOOK.toString(16).toUpperCase()}
  JSL SubmapPalette
  RTS
freecode
SubmapPalette:            ; A (16 bit): $1EEA, its sign the special world passed
  TAX
  LDA $1931 : AND #$000F : DEC : CLC
  TXY : BPL +
  ADC #$0007
+ XBA : ASL
  .table: ADC #$0000
  TAX
  LDY #$0703 : LDA #$01FF
  PHB
  .bank: MVN $00,$00
  PLB
  SEP #$30
  RTL
End:
`;

// the table's address (SNES), null without the patch
export function submapPalettePatch(rom: Rom): { routine: number; table: number } | null {
  if (rom.r8(PAL_HOOK) !== 0x22 || rom.r8(PAL_HOOK + 4) !== 0x60) return null;
  const routine = rom.r24(PAL_HOOK + 1);
  if (rom.r8(routine) !== 0xaa || rom.r16(routine + 1) !== 0x31ad || rom.r8(routine + ROUTINE_ADC - 1) !== 0x69 || rom.r8(routine + ROUTINE_BANK - 2) !== 0x54) return null;
  return { routine, table: (rom.r8(routine + ROUTINE_BANK) << 16) | rom.r16(routine + ROUTINE_ADC) };
}
const table = (rom: Rom) => {
  const p = submapPalettePatch(rom);
  if (!p) throw new Error('Submap palettes (Lunar Magic format) is not installed in this ROM');
  return p.table;
};

// the SNES address of submap `map`'s colors (special: after the special world)
export const submapPaletteAddr = (rom: Rom, map: number, special = false): number => table(rom) + (map + (special ? SUBMAPS : 0)) * SUBMAP_PALETTE_SIZE;
export const submapPalette = (rom: Rom, map: number, special = false): Uint8Array => rom.bytes(submapPaletteAddr(rom, map, special), SUBMAP_PALETTE_SIZE);
export const submapColor = (rom: Rom, map: number, special: boolean, i: number): number => rom.r16(submapPaletteAddr(rom, map, special) + i * 2);
export function setSubmapColor(rom: Rom, map: number, special: boolean, i: number, v: number): void {
  rom.w16(submapPaletteAddr(rom, map, special) + i * 2, v & 0x7fff);
}
export function setSubmapPalette(rom: Rom, map: number, special: boolean, colors: Uint8Array): void {
  if (colors.length !== SUBMAP_PALETTE_SIZE) throw new Error(`A submap palette has ${SUBMAP_PALETTE_SIZE} bytes`);
  rom.writeBytes(submapPaletteAddr(rom, map, special), colors);
}

// the ROM bytes of the palettes (PC offsets, [start, end))
export function submapPaletteRanges(rom: Rom): [number, number][] {
  const p = submapPalettePatch(rom);
  return p ? [[snesToPc(p.table), snesToPc(p.table) + SUBMAP_PALETTES * SUBMAP_PALETTE_SIZE]] : [];
}

// The colors the game's routine ($00AD25) leaves in the palette buffer while the overworld loads on each submap, as
// after loading a save: submaps 0–6, then the same after the special world. In this ROM (the routine as the game's, or
// with the patch: its table read).
export function gameSubmapPalettes(rom: Rom): Uint8Array {
  const emu = new OverworldEmulator(rom), cpu = emu.snes.cpu, w = emu.snes.wram;
  const out = new Uint8Array(SUBMAP_PALETTES * SUBMAP_PALETTE_SIZE);
  const exec = cpu.exec.bind(cpu);
  let special = false, got: Uint8Array | null = null;
  cpu.exec = (op: number) => {
    if ((cpu.opPc & 0x7fffff) === PAL_ROUTINE) { if (special) w[SPECIAL_FLAG] |= 0x80; else w[SPECIAL_FLAG] &= 0x7f; }
    exec(op);
    if (cpu.pc === (PAL_RETURN & 0xffff) && (cpu.pbr & 0x7f) === 0) got = w.slice(0x703, 0x703 + SUBMAP_PALETTE_SIZE);
  };
  try {
    for (let k = 0; k < SUBMAP_PALETTES; k++) {
      special = k >= SUBMAPS;
      got = null;
      emu.load(k % SUBMAPS, 0);
      if (!got) throw new Error(`The overworld's palette of submap ${k % SUBMAPS} was not loaded`);
      out.set(got, k * SUBMAP_PALETTE_SIZE);
    }
  } finally { cpu.exec = exec; }
  return out;
}

// needs Asar (loadAsar) to be loaded; every submap gets the colors the game gives it (emulated)
export function installSubmapPalettePatch(rom: Rom): void {
  if (submapPalettePatch(rom)) return;
  const colors = gameSubmapPalettes(rom);
  const r = assemble(rom.data, new Map([['submappal.asm', routineAsm()]]), 'submappal.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  const routine = r.labels['SubmapPalette'];
  if (r.labels['SubmapPalette_table'] !== routine + ROUTINE_ADC - 1 || r.labels['SubmapPalette_bank'] !== routine + ROUTINE_BANK - 2 || r.labels['End'] !== routine + ROUTINE_LEN) throw new Error('Submap palettes: the routine is not laid out as Lunar Magic\'s');
  // the routine in a block of its own (RATS), then the hook
  const code = r.rom.slice(snesToPc(routine), snesToPc(routine) + ROUTINE_LEN);
  const at = rom.allocWrite(code);
  const tbl = rom.allocWrite(colors);
  if ((tbl & 0xffff) + colors.length > 0x10000) throw new Error('Submap palettes: the table crosses a bank');
  rom.w16(at + ROUTINE_ADC, tbl & 0xffff);
  rom.w8(at + ROUTINE_BANK, tbl >> 16);
  rom.writeBytes(PAL_HOOK, Uint8Array.from([0x22, at & 0xff, (at >> 8) & 0xff, at >> 16, 0x60]));
}
