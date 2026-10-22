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

import type { Rom } from './rom.ts';
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
  return `asar 1.90
lorom
!Count = ${hx(TELEPORTS)}

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

const sameTile = (a: OwTile, b: OwTile) => a.submap === b.submap && a.x === b.x && a.y === b.y;
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
