// Level names as free text, in Lunar Magic's layout (an editor patch, ADR 0004, in Lunar Magic's format, ADR 0005; docs/research/lunar-magic-level-names.md).
// The game builds a translevel's name from three words of shared tables (its code at $04A0FC, drawn by $049D07);
// Lunar Magic replaces that with a name of its own per translevel: where the game looks the code up and draws it –
// $048E81 when the overworld loads, $049549 when Mario stops on a tile – a JSL to $03BB20 (then NOPs, 10 bytes in
// all), whose routine writes the name's 19 tiles from a table – 0x60 × 19 bytes in free space, its address the
// operand of the LDA.l at $03BB56 – as the stripe the game wrote (layer 3 at $508B, attribute $39). The routine is
// Lunar Magic's, byte for byte, so tools reading the table's address there find it.
// The text of a name follows Lunar Magic's built-in table for level names: a tile per character, `\XX` for a tile
// without one, and its "MultiChar" tiles – the game's squished tiles for "YELLOW" and " ILLUSI" (the tiles of names
// typed in Lunar Magic 3.71 confirm it, docs/research/lunar-magic-level-names.md).

import { Rom, snesToPc } from './rom.ts';
import { Snes } from './snes.ts';
import { assemble } from './asar.ts';
import { RAM } from './ram.ts';
import type { OwRefusalData } from './owrefusal.ts';

export const NAME_LEN = 19; // tiles of a name on the overworld's border
export const NAME_TRANSLEVELS = 0x60;
export const NAME_SPACE = 0x1f;
export const NAME_VRAM = 0x508b; // where the game writes a name: layer 3's tilemap (word address), its row 4 from column 11
export const NAME_ATTR = 0x39; // the tiles' attribute: BG3 tile $100 + the tile, palette 6, priority
const NAME_CODES = 0x04a0fc; // the game's: 16 bit per translevel, $FFFF (the unused translevels) shows RAM as letters
const TILE_HOOK = 0x049549, TILE_HOOK_END = 0x049553, LOAD_HOOK = 0x048e81, HOOK_LEN = 10;
export const NAME_ROUTINE = 0x03bb20, NAME_ROUTINE_END = 0x03bb72;
export const NAME_TABLE_OP = 0x03bb57; // operand of LDA.l table,x
export const NAME_HOOKS: [number, number][] = [[LOAD_HOOK, HOOK_LEN], [TILE_HOOK, HOOK_LEN]];
// the game's places the patch writes (SNES address, length), Lunar Magic's hijack: the hooks and the routine; a third-party
// patch may not change them (patchapply.ts)
export const LEVEL_NAME_HOOKS: [number, number][] = [...NAME_HOOKS, [NAME_ROUTINE, NAME_ROUTINE_END - NAME_ROUTINE]];

const hx = (n: number) => '$' + n.toString(16).toUpperCase().padStart(6, '0');
const levelNameAsm = () => `lorom
org ${hx(LOAD_HOOK)}                 ; the overworld loads
  JSL LevelName                      ; A (16 bit): the translevel
  NOP #6
org ${hx(TILE_HOOK)}                 ; Mario stops on a tile
  JSL LevelName
  NOP #6
org ${hx(NAME_ROUTINE)}
LevelName:
  STA $02 : ASL #4 : STA $00
  LDA $02 : ASL : CLC : ADC $02 : ADC $00 : TAX   ; × 19
  PHB : PEA $7F7F : PLB : PLB
  LDA $837B : TAY
  CLC : ADC #$0026 : STA $02
  CLC : ADC #$0004 : STA $837B
  LDA #$2500 : STA $837F,y
  LDA #$${(((NAME_VRAM & 0xff) << 8) | (NAME_VRAM >> 8)).toString(16).toUpperCase()} : STA $837D,y   ; the stripe's VRAM address, high byte first
  SEP #$20
.tile:
  .table: LDA.l $000000,x
  STA $8381,y
  LDA #$${NAME_ATTR.toString(16).toUpperCase()} : STA $8382,y
  INY #2
  INX
  CPY $02 : BCC .tile
  LDA #$FF : STA $8381,y
  REP #$20
  PLB
  RTL
End:
`;

export function levelNamePatch(rom: Rom): { table: number } | null {
  if ([LOAD_HOOK, TILE_HOOK].some((a) => rom.r8(a) !== 0x22 || (rom.r24(a + 1) & 0x7fffff) !== NAME_ROUTINE)) return null;
  return { table: rom.r24(NAME_TABLE_OP) };
}
// (not patches.ts' missingPatch: it leads back here through patchapply.ts)
const table = (rom: Rom) => {
  const p = levelNamePatch(rom);
  if (!p) throw new Error('Level names (Lunar Magic format) is not installed in this ROM');
  return p.table;
};

// the 19 tiles of translevel tl's name
export function levelNameTiles(rom: Rom, tl: number): number[] {
  return [...rom.bytes(table(rom) + tl * NAME_LEN, NAME_LEN)];
}
// at most 19 tiles, padded with spaces
export function setLevelNameTiles(rom: Rom, tl: number, tiles: number[]): void {
  if (tiles.length > NAME_LEN) throw new Error(`A level name has at most ${NAME_LEN} tiles (${tiles.length})`);
  rom.writeBytes(table(rom) + tl * NAME_LEN, Uint8Array.from({ length: NAME_LEN }, (_, k) => tiles[k] ?? NAME_SPACE));
}
export const hasLevelName = (rom: Rom, tl: number): boolean => levelNameTiles(rom, tl).some((t) => t !== NAME_SPACE);
export const clearLevelName = (rom: Rom, tl: number): void => setLevelNameTiles(rom, tl, []);
// the name as text (Lunar Magic's MultiChar tiles as their letters), "(no name)" when blank
export function levelName(rom: Rom, tl: number): string {
  return decodeName(levelNameTiles(rom, tl)).trim() || '(no name)';
}

// the ROM bytes of the names (PC offsets, [start, end))
export function levelNameRanges(rom: Rom): [number, number][] {
  const p = levelNamePatch(rom);
  return p ? [[snesToPc(p.table), snesToPc(p.table) + NAME_TRANSLEVELS * NAME_LEN]] : [];
}

// ---- text ----
// Lunar Magic 3.71's built-in table for level names (tile = character), its MultiChar entries last
const TABLE: [number[], string][] = [
  ...Array.from({ length: 26 }, (_, i) => [[i], String.fromCharCode(65 + i)] as [number[], string]),
  [[0x1a], '!'], [[0x1b], '.'], [[0x1c], '-'], [[0x1d], ','], [[0x1e], '?'], [[0x1f], ' '],
  ...Array.from({ length: 26 }, (_, i) => [[0x40 + i], String.fromCharCode(97 + i)] as [number[], string]),
  [[0x5a], '#'], [[0x5b], '('], [[0x5c], ')'], [[0x5d], "'"],
  ...Array.from({ length: 7 }, (_, i) => [[0x64 + i], String(i + 1)] as [number[], string]), [[0x6b], '0'], [[0xae], '8'], [[0xaf], '9'],
];
export const MULTI_CHAR: [number[], string][] = [[[0x32, 0x33, 0x34, 0x35, 0x36, 0x37], ' ILLUSI'], [[0x38, 0x39, 0x3a, 0x3b, 0x3c], 'YELLOW']];
const TILE_CHAR = new Map(TABLE.map(([t, s]) => [t[0], s]));
const CHAR_TILE = new Map(TABLE.map(([t, s]) => [s, t[0]]));
// the character of a tile (undefined: none, written `\XX`)
export const tileChar = (t: number): string | undefined => TILE_CHAR.get(t);
export const tileEscape = (t: number): string => `\\${t.toString(16).toUpperCase().padStart(2, '0')}`;

// the text of a name's tiles, trailing spaces left out; multi: Lunar Magic's MultiChar tiles as their letters (else `\XX`)
export function decodeName(tiles: number[], multi = true): string {
  let s = '';
  for (let i = 0; i < tiles.length;) {
    const m = multi ? MULTI_CHAR.find(([t]) => t.every((v, k) => tiles[i + k] === v)) : undefined;
    if (m) { s += m[1]; i += m[0].length; continue; }
    s += TILE_CHAR.get(tiles[i]) ?? tileEscape(tiles[i]);
    i++;
  }
  return s.replace(/ +$/, '');
}

// the tiles of a name's text: `\XX` a tile by number; multi: "YELLOW" and " ILLUSI" as Lunar Magic's MultiChar
// tiles. missing: the characters without a tile (left out), with their place in the text; shown: the tiles with -1
// in the place of each of them
export interface EncodedName { tiles: number[]; missing: { ch: string; at: number }[]; shown: number[] }
export function encodeName(text: string, multi = true): EncodedName {
  const tiles: number[] = [], missing: { ch: string; at: number }[] = [], shown: number[] = [];
  for (let i = 0; i < text.length;) {
    const e = /^\\([0-9a-fA-F]{2})/.exec(text.slice(i, i + 3));
    if (e) { tiles.push(parseInt(e[1], 16)); shown.push(parseInt(e[1], 16)); i += 3; continue; }
    const m = multi ? MULTI_CHAR.find(([, s]) => text.startsWith(s, i)) : undefined;
    if (m) { tiles.push(...m[0]); shown.push(...m[0]); i += m[1].length; continue; }
    const ch = String.fromCodePoint(text.codePointAt(i)!), t = CHAR_TILE.get(ch);
    if (t === undefined) missing.push({ ch, at: i });
    else tiles.push(t);
    shown.push(t ?? -1);
    i += ch.length;
  }
  return { tiles, missing, shown };
}

// ---- a name typed in place (the overworld's layer 1 mode, #369): as its tiles, drawn in the map's font ----
// a name being typed: its tiles (trailing spaces left out) and the caret, before tile `at`
export interface NameCaret { tiles: number[]; at: number }
// a name's tiles without the trailing spaces (what is typed into)
export function trimName(tiles: number[]): number[] {
  let n = tiles.length;
  while (n && tiles[n - 1] === NAME_SPACE) n--;
  return tiles.slice(0, n);
}
// a character typed at the caret: its tile put in; why it is refused (a refusal, owrefusal.ts): the font has no tile for
// it (a tile by number is typed in the properties' name field, `\XX`), the name has its 19 tiles
export function typeNameChar(n: NameCaret, ch: string): NameCaret | OwRefusalData {
  const t = CHAR_TILE.get(ch);
  if (t === undefined) return { kind: 'nameNoChar', ch };
  if (n.tiles.length >= NAME_LEN) return { kind: 'nameFull', max: NAME_LEN };
  return { tiles: [...n.tiles.slice(0, n.at), t, ...n.tiles.slice(n.at)], at: n.at + 1 };
}
// Backspace, Delete, ←, →, Home, End at the caret (null: not one of them)
export function nameKey(n: NameCaret, key: string): NameCaret | null {
  const { tiles, at } = n;
  switch (key) {
    case 'Backspace': return at ? { tiles: [...tiles.slice(0, at - 1), ...tiles.slice(at)], at: at - 1 } : n;
    case 'Delete': return { tiles: [...tiles.slice(0, at), ...tiles.slice(at + 1)], at };
    case 'ArrowLeft': return { tiles, at: Math.max(0, at - 1) };
    case 'ArrowRight': return { tiles, at: Math.min(tiles.length, at + 1) };
    case 'Home': return { tiles, at: 0 };
    case 'End': return { tiles, at: tiles.length };
  }
  return null;
}

// ---- the game's names ----
// the stripe the overworld's code writes for translevel tl's name (as where Mario stands on its tile, $049549 up to
// $049553 run with A = tl): its 4-byte header, the tiles with their attribute, the end mark $FF
export function shownNameStripe(rom: Rom, tl: number, s = new Snes(rom.data)): number[] {
  const cpu = s.cpu, w = s.wram, bank = TILE_HOOK >> 16, end = TILE_HOOK_END & 0xffff;
  w[RAM.stripeEnd] = 0; w[RAM.stripeEnd + 1] = 0;
  w.fill(0, RAM.stripes, RAM.stripes + 0x40);
  cpu.e = false; cpu.p = 0x04; cpu.s = 0x1ff; cpu.d = 0; cpu.dbr = bank; cpu.pbr = bank; cpu.pc = TILE_HOOK & 0xffff; cpu.a = tl;
  for (let n = 0; n < 100_000 && !((cpu.pbr & 0x7f) === bank && cpu.pc === end); n++) cpu.step();
  if (cpu.pc !== end) throw new Error(`The level name of translevel ${tl.toString(16)} was not written`);
  return [...w.subarray(RAM.stripes, RAM.stripes + w[RAM.stripeEnd] + 1)];
}
const nameless = (rom: Rom, tl: number) => [0, 0xffff].includes(rom.r16(NAME_CODES + tl * 2));

// needs Asar (loadAsar) to be loaded; every translevel gets the name the game shows for it (its routine emulated),
// those without one ($0000 blank, $FFFF RAM shown as letters) a blank name
export function installLevelNamePatch(rom: Rom): void {
  if (levelNamePatch(rom)) return;
  const s = new Snes(rom.data), names = new Uint8Array(NAME_TRANSLEVELS * NAME_LEN).fill(NAME_SPACE);
  for (let tl = 0; tl < NAME_TRANSLEVELS; tl++) {
    if (nameless(rom, tl)) continue;
    const st = shownNameStripe(rom, tl, s);
    for (let k = 0; k < NAME_LEN; k++) names[tl * NAME_LEN + k] = st[4 + k * 2];
  }
  const r = assemble(rom.data, new Map([['levelnames.asm', levelNameAsm()]]), 'levelnames.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  if (r.labels['LevelName_table'] + 1 !== NAME_TABLE_OP || r.labels['End'] !== NAME_ROUTINE_END) throw new Error('Level names: the routine is not laid out as Lunar Magic\'s');
  for (const [a, n] of LEVEL_NAME_HOOKS) rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
  rom.w24(NAME_TABLE_OP, rom.allocWrite(names));
}
