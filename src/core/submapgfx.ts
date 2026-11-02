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
import { levelGfx, setLevelGfx, defaultGfx, submapGfxEntry, GFX_NONE, SUBMAPS } from './patches.ts';
export { SUBMAPS };
import { levelSlots as entrySlotsOf, assignSlot, type GfxSlot } from './gfxslots.ts';
import { LT3_SLOT, type Lt3Place } from './layer3gfx.ts';
// where a submap's LT3 file goes: the start of layer 3 (LT3_DESTS)
export const SUBMAP_LT3_DEST = 1;

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
const COLORS = RAM.palettes + 2; // the palette buffer: the colors after the back area color

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
    if (cpu.pc === (PAL_RETURN & 0xffff) && (cpu.pbr & 0x7f) === 0) got = w.slice(COLORS, COLORS + SUBMAP_PALETTE_SIZE);
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

// ---- graphics files ----
// A submap's graphics slots: FG1–FG4 (the overworld's tileset, $04DC02 per submap, as the game loads it into the
// level's FG1/FG2/BG1/FG3 places) and SP1–SP4 (its sprite set, $04DC1D); FF the default. Kept in the editor patch's
// bypass (patches.ts, entries 200–206), which the overworld's load reads for the submap Mario is on. Lunar Magic's
// "Submap GFX" has these slots, and FG5/FG6 (only with its option to merge FG1/FG2 into SP3/SP4) and AN2, which the
// editor doesn't offer (docs/research/lunar-magic-submap-graphics.md, "FG5/FG6 and AN2"); its table and
// code are its own (the editor's bypass differs from Lunar Magic's for levels too), the place where the game changes
// the submap is its: when Mario walks to another submap the game loads only its palette ($04DBAE), so a JSL at
// $04DBB9 (Lunar Magic's place) loads the new submap's graphics there – the game's own routine ($00A9DA, which
// uploads only the files that changed), the screen turned off meanwhile (the window has closed over it). Then, the
// screen still off, the overworld load's set-up of the animated tiles runs as at the load ($048086, where the
// ExAnimation hooks in): the game's tiles from their start, the new submap's lists set up and run eight frames with
// their uploads, so the window opens on its animations (Lunar Magic keeps the lists the load set up until the next
// load, docs/research/lunar-magic-submap-graphics.md).
const OW_TILESETS = 0x04dc02; // per submap: the tileset $1931
const OW_SPRITE_SET = 0x04dc1d; // the operand of LDA #$11 : STA $192B ($04DC09, the overworld's load)
const GFX_HOOK = 0x04dbb9; // STA $0704 : STZ $0803, 6 bytes
const GFX_CODE_LEN = 0x70;
const UPLOAD = 0x00a9da; // the game's graphics upload (JSR; RTS)
const RTL_00 = 0x0084cf; // an RTL in bank 0, where the upload's RTS returns
// the overworld load's set-up of the animated tiles (JSR from $048EEB; RTS): the game's, the ExAnimation's load
// hook (kobo/exanimation.ts: the lists set up for the player's submap and run eight frames with their uploads)
const OW_ANIM_LOAD = 0x048086;
const OW_ANIM_RTL = 0x048414; // an RTL in bank 4, where its RTS returns
const hx = (n: number) => '$' + n.toString(16).toUpperCase().padStart(4, '0');
const gfxHookAsm = (at: number) => `lorom
org $${GFX_HOOK.toString(16).toUpperCase()}
  JSL SubmapGfx
  NOP #2
org $${at.toString(16).toUpperCase()}
SubmapGfx:
  STA ${hx(RAM.palettes + 3)} : STZ ${hx(RAM.palettes + 0x102)}   ; the game's code
  PHP : PHB
  SEP #$30
  LDA #$00 : PHA : PLB
  LDA #$80 : STA $2100            ; screen off, no NMI while the files are uploaded
  STZ $4200
  PHK : PEA.w .ret-1 : PEA.w ${hx((RTL_00 - 1) & 0xffff)} ; the upload's RTS to the RTL, back here
  JML ${hx(UPLOAD).replace('$', '$00')}
.ret:
  REP #$30                        ; the direct page scratch kept around the animations' load
  PEI ($00) : PEI ($02) : PEI ($04) : PEI ($06) : PEI ($08) : PEI ($0A) : PEI ($0C) : PEI ($0E)
  SEP #$30
  LDA #$04 : PHA : PLB
  PHK : PEA.w .anim-1 : PEA.w ${hx((OW_ANIM_RTL - 1) & 0xffff)} ; the animations' load, its RTS to the RTL, back here
  JML ${hx(OW_ANIM_LOAD).replace('$', '$0')}
.anim:
  REP #$30
  PLA : STA $0E : PLA : STA $0C : PLA : STA $0A : PLA : STA $08 : PLA : STA $06 : PLA : STA $04 : PLA : STA $02 : PLA : STA $00
  SEP #$30
  LDA #$81 : STA $4200            ; NMI and the joypad read on again, as the game has them on the overworld
  LDA ${hx(RAM.brightness)} : STA $2100
  PLB : PLP
  RTL
End:
`;
export const OW_GFX_SLOT_NAMES = ['FG1', 'FG2', 'FG3', 'FG4', 'SP1', 'SP2', 'SP3', 'SP4'];
// the slot's place in the bypass (GFX_SLOT_NAMES order: SP4..SP1, then the FG/BG slots FG3, BG1, FG2, FG1 – the
// overworld's FG4, FG3, FG2, FG1)
const BYPASS_K: Record<string, number> = { FG1: 7, FG2: 6, FG3: 5, FG4: 4, SP1: 3, SP2: 2, SP3: 1, SP4: 0 };

// the layer 3 slots of a bypass entry (the header doesn't matter for them)
const entrySlots = (rom: Rom, n: number): GfxSlot[] => entrySlotsOf(rom, n, { tileset: 0, spriteGfx: 0 });
export const submapTileset = (rom: Rom, map: number): number => rom.r8(OW_TILESETS + map);
export const submapSpriteSet = (rom: Rom): number => rom.r8(OW_SPRITE_SET);
export const hasSubmapGfxPatch = (rom: Rom): boolean => rom.r8(GFX_HOOK) === 0x22;

// the slots of submap `map` (first: the slot's first 8x8 tile, as the level's: FG 000–1FF, sprites 000–1FF of OAM, layer
// 3's tiles), then layer 3's LG1–LG4 (the game's 28–2B by default) and LT3 (none: the game's border), as a level's
// (layer3gfx.ts, the submap's entry)
export function submapSlots(rom: Rom, map: number): GfxSlot[] {
  const own = levelGfx(rom, submapGfxEntry(map)), def = defaultGfx(rom, submapTileset(rom, map), submapSpriteSet(rom));
  const gfx = OW_GFX_SLOT_NAMES.map((name, i): GfxSlot => {
    const k = BYPASS_K[name], f = own[k], sprite = i >= 4;
    return { name, kind: 'gfx', k, file: f !== GFX_NONE ? f : def[k], def: def[k], custom: f !== GFX_NONE, first: (i & 3) * 0x80, sprite, map16: !sprite };
  });
  return [...gfx, ...entrySlots(rom, submapGfxEntry(map)).filter((x) => x.kind === 'lg' || x.kind === 'lt3')];
}
// puts `file` into slot `name` of submap `map` (FF: the default; an LT3 file goes to `place` when given)
export function assignSubmapSlot(rom: Rom, map: number, name: string, file: number, place?: Lt3Place): void {
  const k = BYPASS_K[name];
  // (an LT3 file on the overworld goes to the start of layer 3, as in Lunar Magic: the border's place)
  if (k === undefined) { assignSlot(rom, submapGfxEntry(map), name, file, place ?? (name === LT3_SLOT ? { dest: SUBMAP_LT3_DEST, size: 0 } : undefined)); return; }
  const set = levelGfx(rom, submapGfxEntry(map));
  set[k] = file;
  setLevelGfx(rom, submapGfxEntry(map), set);
}

// needs Asar (loadAsar) to be loaded
export function installSubmapGfxPatch(rom: Rom): void {
  if (hasSubmapGfxPatch(rom)) return;
  if (rom.r8(GFX_HOOK) !== 0x8d || rom.r16(GFX_HOOK + 1) !== 0x0704 || rom.r8(RTL_00) !== 0x6b || rom.r8(OW_ANIM_RTL) !== 0x6b) throw new Error('Submap graphics: unexpected code at $04DBB9, $0084CF or $048414');
  const at = rom.allocWrite(new Uint8Array(GFX_CODE_LEN));
  const r = assemble(rom.data, new Map([['submapgfx.asm', gfxHookAsm(at)]]), 'submapgfx.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  if (r.labels['End'] - at > GFX_CODE_LEN) throw new Error('Submap graphics: the code is longer than its block');
  for (const [a, n] of [[GFX_HOOK, 6], [at, GFX_CODE_LEN]]) rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
}
