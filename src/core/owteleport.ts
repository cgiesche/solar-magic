// The overworld's star/pipe table with 0x100 entries, as Lunar Magic 3.00 extends it (LM help
// ov_overworld_locationteleport.htm, level_second_entrance.htm): standing on a star or pipe tile ($049188)
// Mario warps to the destination of the entry whose tile it is, and a secondary entrance to the overworld
// (level.ts OverworldExit) teleports him to the destination of its location index – a star's or pipe's (the
// index of the tile that leads there), or a location of its own.
//
// An entry is the game's four words ($048431, $048467, $04849D, $0484D3, 27 entries): the tile it is taken
// from (X | submap << 8, Y; FFFF: none – a location only teleports to) and its destination (pixel X | submap
// << 9, pixel Y, Mario at tile * 16 + 8 as the game's). The game searches the tiles from the last entry down
// and keeps the found entry's word offset in $1DF6; Lunar Magic keeps the entry's number there (its location
// indexes go there directly, observed in a Lunar Magic-saved ROM), and so does the patch. The tables are the
// editor's, in free space; the game's 27 entries are copied into the first ones.
//
// The exit path table with 0x80 entries, as Lunar Magic 2.40 extends it: walking onto an exit path tile ($04961C)
// the game looks for the entry of Mario's pixel position and submap (from the last entry down; $049A24, 14
// entries) and puts him at its destination on another submap, walking on. An entry is 5 bytes where Mario is (pixel
// Y, pixel X, submap), 5 where he goes (the same) and 2 the tile he goes to (Y, X; $1F21, $1F1F). The patch's
// routine, at a JSL at $049A35, keeps its tables' addresses at +$11, +$2C, +$48 as Lunar Magic's does (where
// Ankouno's OverworldTables.asm finds them).

import { type Rom, snesToPc } from './rom.ts';
import { applyPatch, type ApplyResult } from './patchapply.ts';
import { listPatches } from './patchreg.ts';
import { installEditorPatch, missingPatch } from './patches.ts';
import { RAM } from './ram.ts';
import { MAP_NAMES, eventNames } from './overworld.ts';
import { owActionShort, type OverworldExit } from './level.ts';
import { hex2 } from './names.ts';

export const OW_TELEPORT_PATCH_NAME = 'Overworld teleports (Lunar Magic format)';
export const TELEPORTS = 0x100;
export const FIND_HOOK = 0x048509;
const DEST_HOOK = 0x048543;
export const GAME_TABLES = [0x048431, 0x048467, 0x04849d, 0x0484d3], GAME_ENTRIES = 27;
export const EXIT_PATHS = 0x80;
export const EXIT_HOOK = 0x049a35;
export const GAME_EXIT_TABLES = [0x049964, 0x0499aa, 0x0499f0], GAME_EXITS = 14;
const EXIT_PTRS = [0x11, 0x2c, 0x48]; // the tables' addresses in the routine (Lunar Magic's places)
const MAGIC = [0x53, 0x4d, 0x57, 0x4f]; // "SMWO"
const NONE = 0xffff;
const hx = (n: number) => '$' + n.toString(16).toUpperCase();

// a tile of an overworld map (submap 0 the main map, 1-6 the submaps: MAP_NAMES), 0-31 each
export interface OwTile { submap: number; x: number; y: number }
// an entry: the star or pipe tile it is taken from (null: a location) and where it leads (null: unused)
export interface Teleport { from: OwTile | null; to: OwTile | null }

function asm(): string {
  const w = (a: number, i: number) => `read2(${hx(a + i * 2)})`;
  const game = (t: number) => Array.from({ length: GAME_ENTRIES }, (_, i) => w(GAME_TABLES[t], i)).join(', ');
  const exits = (t: number, size: number) => Array.from({ length: GAME_EXITS * size }, (_, i) => `read1(${hx(GAME_EXIT_TABLES[t] + i)})`).join(', ');
  return `asar 1.90
lorom
!Count = ${hx(TELEPORTS)}
!ExitCount = ${hx(EXIT_PATHS)}

; the star/pipe tile Mario stands on (A/X/Y 8): Z set and $1DF6 the entry when the table has it (the game's
; JSR $8509 : BNE); as the game's, an entry's X word EOR the submap << 8 below $200, then equal to the tile X
org ${hx(FIND_HOOK)}
  JSL Find
  RTS
; the destination of entry $1DF6 (A 16, X 8 = $0DD6): Mario there, A = its submap, then the game's STA $13C3
org $04856A : DestDone:
org ${hx(DEST_HOOK)}
  JSL Dest
  BRA DestDone

freecode
  db ${MAGIC.map(hx).join(',')}
  dl Tbl
  db 0
Find:
  LDY ${hx(RAM.playerIndex)} : LDA ${hx(RAM.submap)},y : STA $01 : STZ $00
  LDY ${hx(RAM.currentPlayer)}
  REP #$30
  LDX.w #(!Count-1)*2
- LDA.l Tbl_fromX,x : EOR $00 : CMP #$0200 : BCS +
  CMP ${hx(RAM.owPlayerTileX)},y : BNE +
  LDA.l Tbl_fromY,x : CMP ${hx(RAM.owPlayerTileY)},y : BNE +
  TXA : LSR
  SEP #$30
  STA ${hx(RAM.owWarpIndex)}
  LDA #$00
  RTL
+ DEX : DEX : BPL -
  SEP #$30
  LDA #$01
  RTL

Dest:
  REP #$10
  PHX
  LDA ${hx(RAM.owWarpIndex)} : AND #$00FF : ASL : TAX
  LDA.l Tbl_toY,x : STA $00
  LDA.l Tbl_toX,x
  PLX
  PHA
  AND #$01FF : STA ${hx(RAM.owPlayerX)},x : LSR #4 : STA ${hx(RAM.owPlayerTileX)},x
  LDA $00 : STA ${hx(RAM.owPlayerY)},x : LSR #4 : STA ${hx(RAM.owPlayerTileY)},x
  PLA : LSR : XBA : AND #$000F
  SEP #$10
  RTL

; the exit path Mario walks onto (A 16, X/Y 8, $13C3 his submap): the entry of his position, its destination
org ${hx(EXIT_HOOK)}
  JSL Exits
  RTS

freecode
Exits:
  LDY ${hx(RAM.currentPlayer)}
  REP #$10
  LDX.w #(!ExitCount-1)*5
  LDA.w #(!ExitCount-1)*2 : STA $02
.loop
  LDA ${hx(RAM.owPlayerY)},y
  assert (pc()-Exits)&$FFFF == ${hx(EXIT_PTRS[0] - 1)}
  CMP.l ExitFrom,x : BNE .next
  LDA ${hx(RAM.owPlayerX)},y : CMP.l ExitFrom+2,x : BNE .next
  LDA.l ExitFrom+4,x : AND #$00FF : CMP ${hx(RAM.owSubmap)} : BNE .next
  assert (pc()-Exits)&$FFFF == ${hx(EXIT_PTRS[1] - 1)}
  LDA.l ExitTo,x : STA ${hx(RAM.owPlayerY)},y
  LDA.l ExitTo+2,x : STA ${hx(RAM.owPlayerX)},y
  LDA.l ExitTo+4,x : AND #$00FF : STA ${hx(RAM.owSubmap)}
  LDX $02
  SEP #$20
  assert (pc()-Exits)&$FFFF == ${hx(EXIT_PTRS[2] - 1)}
  LDA.l ExitTile,x : STA ${hx(RAM.owPlayerTileY)},y
  LDA.l ExitTile+1,x : STA ${hx(RAM.owPlayerTileX)},y
  LDA #$00 : STA ${hx(RAM.owPlayerTileY + 1)},y : STA ${hx(RAM.owPlayerTileX + 1)},y
  BRA .done
.next
  DEC $02 : DEC $02
  TXA : SEC : SBC.w #5 : TAX : BPL .loop
.done
  SEP #$30
  RTL

ExitFrom:
  db ${exits(0, 5)}
  fillbyte $00 : fill (!ExitCount-${GAME_EXITS})*5
ExitTo:
  db ${exits(1, 5)}
  fillbyte $00 : fill (!ExitCount-${GAME_EXITS})*5
ExitTile:
  db ${exits(2, 2)}
  fillbyte $00 : fill (!ExitCount-${GAME_EXITS})*2

Tbl:
.fromX
  dw ${game(0)}
  fillword $FFFF : fill (!Count-${GAME_ENTRIES})*2
.fromY
  dw ${game(1)}
  fillword $0000 : fill (!Count-${GAME_ENTRIES})*2
.toX
  dw ${game(2)}
  fillword $0000 : fill (!Count-${GAME_ENTRIES})*2
.toY
  dw ${game(3)}
  fillword $0000 : fill (!Count-${GAME_ENTRIES})*2
`;
}

export function owTeleportEntry(rom: Rom) {
  return listPatches(rom).find((p) => p.kind === 'owteleport') ?? null;
}

function table(rom: Rom): number {
  if (rom.r8(FIND_HOOK) === 0x22) {
    const base = rom.r24(FIND_HOOK + 1) - 8;
    if (MAGIC.every((m, i) => rom.r8(base + i) === m)) return rom.r24(base + 4);
  }
  return missingPatch('Overworld teleports (SMWO)');
}

// needs Asar (loadAsar) to be loaded
export function installOwTeleportPatch(rom: Rom): ApplyResult {
  const e = owTeleportEntry(rom);
  if (e) return { ok: true, errors: [], warnings: [], prints: [], entry: e };
  installEditorPatch(rom);
  return applyPatch(rom, { name: OW_TELEPORT_PATCH_NAME, main: 'owteleport.asm', files: new Map([['owteleport.asm', asm()]]), kind: 'owteleport' });
}

const PART = TELEPORTS * 2; // a table's bytes
export function readTeleport(rom: Rom, i: number): Teleport {
  const t = table(rom), w = (k: number) => rom.r16(t + k * PART + i * 2);
  const fx = w(0), fy = w(1), tx = w(2), ty = w(3);
  return {
    from: fx === NONE ? null : { submap: fx >> 8, x: fx & 0xff, y: fy },
    to: tx === 0 && ty === 0 ? null : { submap: (tx >> 9) & 15, x: (tx & 0x1ff) >> 4, y: ty >> 4 },
  };
}
export function writeTeleport(rom: Rom, i: number, e: Teleport): void {
  const t = table(rom), w = (k: number, v: number) => rom.w16(t + k * PART + i * 2, v);
  w(0, e.from ? (e.from.submap << 8) | e.from.x : NONE);
  w(1, e.from ? e.from.y : 0);
  w(2, e.to ? (e.to.submap << 9) | (e.to.x * 16 + 8) : 0);
  w(3, e.to ? e.to.y * 16 + 8 : 0);
}
export const readTeleports = (rom: Rom): Teleport[] => Array.from({ length: TELEPORTS }, (_, i) => readTeleport(rom, i));

// ---- exit paths ----
// a pixel position of an overworld map (Mario's, 16-bit; on a tile he stands at its 16x16 block's +8,+8)
export interface OwPos { submap: number; x: number; y: number }
// an entry: where Mario is when he leaves, where he goes and the tile he is on there (null: unused, all 0)
export interface ExitPath { from: OwPos; to: OwPos; tile: { x: number; y: number } }

function exitTables(rom: Rom): number[] {
  if (rom.r8(EXIT_HOOK) !== 0x22) missingPatch('Overworld exit paths (SMWO)');
  const code = rom.r24(EXIT_HOOK + 1);
  return EXIT_PTRS.map((o) => rom.r24(code + o));
}
export function readExitPath(rom: Rom, i: number): ExitPath | null {
  const [f, t, k] = exitTables(rom), pos = (a: number): OwPos => ({ y: rom.r16(a), x: rom.r16(a + 2), submap: rom.r8(a + 4) });
  if (rom.bytes(f + i * 5, 5).every((b) => !b) && rom.bytes(t + i * 5, 5).every((b) => !b) && !rom.r16(k + i * 2)) return null;
  return { from: pos(f + i * 5), to: pos(t + i * 5), tile: { y: rom.r8(k + i * 2), x: rom.r8(k + i * 2 + 1) } };
}
export function writeExitPath(rom: Rom, i: number, e: ExitPath | null): void {
  const [f, t, k] = exitTables(rom), pos = (a: number, p: OwPos | undefined) => { rom.w16(a, p?.y ?? 0); rom.w16(a + 2, p?.x ?? 0); rom.w8(a + 4, p?.submap ?? 0); };
  pos(f + i * 5, e?.from);
  pos(t + i * 5, e?.to);
  rom.w8(k + i * 2, e?.tile.y ?? 0);
  rom.w8(k + i * 2 + 1, e?.tile.x ?? 0);
}
export const readExitPaths = (rom: Rom): (ExitPath | null)[] => Array.from({ length: EXIT_PATHS }, (_, i) => readExitPath(rom, i));
// the bytes of the tables (PC offsets, [start, end)): of the star/pipe table and the exit path table
export function teleportDataRanges(rom: Rom): [number, number][] {
  const at = (snes: number, len: number): [number, number] => [snesToPc(snes), snesToPc(snes) + len];
  const out: [number, number][] = [];
  if (rom.r8(FIND_HOOK) === 0x22) out.push(at(table(rom), PART * 4));
  if (rom.r8(EXIT_HOOK) === 0x22) { const [f, t, k] = exitTables(rom); out.push(at(f, EXIT_PATHS * 5), at(t, EXIT_PATHS * 5), at(k, EXIT_PATHS * 2)); }
  return out;
}

export const sameTile = (a: OwTile, b: OwTile) => a.submap === b.submap && a.x === b.x && a.y === b.y;
// the location index that teleports to a tile: an entry leading there (a star's or pipe's, or a location), else
// a new location in an unused entry (written), else null (all 0x100 in use); `keep`: entries in use that may look
// unused (a teleport not set up yet)
export function locationFor(rom: Rom, tile: OwTile, keep: Set<number> = new Set()): number | null {
  const all = readTeleports(rom);
  const at = all.findIndex((e) => e.to && sameTile(e.to, tile));
  if (at >= 0) return at;
  const free = all.findIndex((e, i) => !e.from && !e.to && !keep.has(i));
  if (free < 0) return null;
  writeTeleport(rom, free, { from: null, to: { ...tile } });
  return free;
}

export const tileText = (t: OwTile): string => `${MAP_NAMES[t.submap] ?? `Submap ${t.submap}`} ${hex2(t.x)},${hex2(t.y)}`;
// where location `i` teleports to: "Main map 0C,09", "(location 1F not set up)"
export function locationText(rom: Rom, i: number): string {
  const to = readTeleport(rom, i).to;
  return to ? tileText(to) : `(location ${hex2(i)} not set up)`;
}
// what an exit through an entrance to the overworld does: "normal exit, event 12 – 105 …, teleport to Main map 0C,09"
export function overworldExitText(rom: Rom, o: OverworldExit): string {
  const parts = [owActionShort(o.action)];
  const name = o.ownEvent ? eventNames(rom).get(o.event) : undefined;
  if (o.ownEvent) parts.push(`base event ${hex2(o.event)}${name ? ` (${name})` : ''}`);
  if (o.teleport) parts.push(`teleport to ${locationText(rom, o.location)}`);
  return parts.join(', ');
}
