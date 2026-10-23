// Layer 2 event steps (ADR 0005, CONTEXT.md "Event step"), in Lunar Magic's formats. An event changes layer 2 in
// pieces of 8x8 tiles: a 6x6 or 2x2 block of the event tile storage written at a position of the layer 2 tilemap
// ($7F4000, 2 bytes per tile; the game's $04E4A9). Its standard steps are shown one after the other with the
// path fade ($04E6F9, on the submap Mario is on), its silent ones written at once when it ends ($04E9EC).
//
// - steps: 4 bytes each, the piece's storage index and its tilemap position ($04DD8D; Lunar Magic moves the table
//   to free space, its pointer the operands at $04E49F/$04E709/$04EE5A, + 2 at $04E4A4/$04E710/$04EE3F); an
//   event's steps are those from its divider to the next one's ($04E359, 0x79 words)
// - the storage: tile numbers ($0C8000; Lunar Magic's pointer at $04E4B0/$04E4BB and $04EAF5) and their
//   YXPCCCTT (LC_RLE1 from $0C8D00 to $7F0000 when the overworld loads; pointer $04DD45/$04DD4A); an index below
//   the 6x6 area ($0900, the operands at $04E4C0, $04E745, $04EAD8, $04EE5E) is a 6x6 piece, above it 2x2
// - silent steps: the game's 0x2C entries ($04E8E4 event, $04E910 layer, $04E93C position, $04E994 tile), Lunar
//   Magic's silent event hack (a JSL at $04E9F7) with a divider per event like the steps': read3(read3($04E9F8)
//   + $0D) dividers (byte offsets), + $22 the tiles (16-bit: a storage index on layer 2, a Map16 tile on layer 1),
//   + $28 the positions ($7F4000 / $7EC800), + $34 the layers (1 byte, 1 layer 2); a JSL at $04DCA5 writes the
//   layer 2 ones of each passed event when a file is loaded, after its standard steps, as Ankouno's
//   OverworldTables.asm and SMW Central's hijack map describe it and Lunar Magic's code in the ROMs it saved does.
//
// The patch (installEventPatch) brings the clean game into that layout: steps, storage and silent steps in free
// space, the silent event hook, 0x78 events (the loops at $04D859 and $04DCAA, the reveal tables moved and
// extended, $04DA74 …). The editor's code is its own; its table operands are where Lunar Magic's are.

import { snesToPc, type Rom } from './rom.ts';
import { assemble } from './asar.ts';
import { rleEncode } from './rle.ts';
import { missingPatch } from './patches.ts';
import { OW_EVENTS } from './overworld.ts';

const DIVIDERS = 0x04e359; // 0x79 words: the first step of each event, the end
const STEP_OPS = [0x04e49f, 0x04e709, 0x04ee5a], STEP_OPS2 = [0x04e4a4, 0x04e710, 0x04ee3f];
const TILE_BANK = 0x04e4b0, TILE_LO = 0x04e4bb, TILE_LONG = 0x04eaf5;
const PROP_LO = 0x04dd45, PROP_BANK = 0x04dd4a;
const AREA6_OPS = [0x04e4c0, 0x04e745, 0x04ead8, 0x04ee5e];
const SILENT_HOOK = 0x04e9f7, LOAD_HOOK = 0x04dca5, LOAD_COUNT = 0x04dcaa, TL_COUNT = 0x04d859;
const SILENT_DIV = 0x0d, SILENT_TILES = 0x22, SILENT_LOCS = 0x28, SILENT_LAYERS = 0x34;
const GAME_SILENT = { events: 0x04e8e4, layers: 0x04e910, locs: 0x04e93c, tiles: 0x04e994, count: 0x2c };
// the reveal tables (per event: the layer 1 tile, its VRAM address), 0x70 entries in the game
const REVEAL_OPS = [0x04da74, 0x04ec8c, 0x04ecba, 0x04ecc5, 0x04ed97, 0x04edbe], REVEAL_VRAM_OP = 0x04edb8;
const GAME_REVEAL = 0x04d85d, GAME_REVEAL_VRAM = 0x04d93d, GAME_REVEALS = 0x70;

// the event tile storage's limit: its YXPCCCTT go to $7F0000, below the level heights patch's RAM at $7F3666
export const STORAGE_MAX = 0x3600;
export const PIECE6 = 36, PIECE2 = 4;
const STEP_SLACK = 0x100, STORAGE_SLACK = 0x200, SILENT_SLACK = 0x40; // room for later edits in each block

// a piece of an event: its storage index and its tilemap position (a byte offset of $7F4000)
export interface Piece { at: number; pos: number }
// a silent step: on layer 2 a piece (tile its storage index), on layer 1 a Map16 tile at an offset of $7EC800
export interface Silent { layer: 1 | 2; tile: number; loc: number }
export interface EventData {
  area6: number; // storage indexes below it are 6x6 pieces
  storage: Uint16Array; // tile words (tile number, YXPCCCTT)
  steps: Piece[][]; // per event, in order
  silent: Silent[][]; // per event, in the order the game writes them
}

export const hasEventPatch = (rom: Rom): boolean => rom.r8(SILENT_HOOK) === 0x22;
const silentCode = (rom: Rom) => rom.r24(SILENT_HOOK + 1);
export const isBig = (d: { area6: number }, at: number): boolean => at < d.area6;

// the layer 2 tiles (indexes of readL2's map) a piece at `pos` writes, in storage order: rows of 6 or 2 tiles,
// crossing into the next 32x32 block as the game's $04E4D0/$04E520 do; a tile outside the tilemap is left out (-1)
export function pieceCells(pos: number, big: boolean): number[] {
  const n = big ? 6 : 2, out: number[] = [];
  let row = pos;
  for (let r = 0; r < n; r++) {
    let x = row;
    for (let c = 0; c < n; c++) {
      out.push(x < 0x4000 ? x >> 1 : -1);
      x = (x + 2) & 0xffff;
      if ((x & 0x3f) === 0) x = (((x - 1) & 0xffc0) + 0x800) & 0xffff;
    }
    const next = (row + 0x40) & 0xffff;
    row = next & 0x7c0 ? next : ((row & 0xf83f) + 0x1000) & 0xffff;
  }
  return out;
}
// the position of the piece whose top left tile is l2 index i
export const piecePos = (i: number): number => i * 2;

// LC_RLE1 as the game's $04DD57: a control byte n, bit 7 set: the next byte (n & $7F) + 1 times, else n + 1 bytes;
// a word $FFFF where a control byte would be ends it
function rle1Decode(rom: Rom, at: number): number[] {
  const d = rom.data, out: number[] = [];
  let p = snesToPc(at);
  while (p + 1 < d.length && !(d[p] === 0xff && d[p + 1] === 0xff)) {
    const c = d[p++];
    if (c & 0x80) { const v = d[p++]; for (let i = 0; i <= (c & 0x7f); i++) out.push(v); }
    else for (let i = 0; i <= c; i++) out.push(d[p++]);
  }
  return out;
}
const rle1Encode = (v: number[]) => Uint8Array.from([...rleEncode(v, true), 0xff, 0xff]);

const stepTable = (rom: Rom) => rom.r24(STEP_OPS[0]);
const tileTable = (rom: Rom) => (rom.r8(TILE_BANK) << 16) | rom.r16(TILE_LO);
const propTable = (rom: Rom) => (rom.r8(PROP_BANK) << 16) | rom.r16(PROP_LO);

export function readEvents(rom: Rom): EventData {
  const area6 = rom.r16(AREA6_OPS[0]);
  const props = rle1Decode(rom, propTable(rom)), tiles = tileTable(rom);
  const storage = Uint16Array.from(props, (p, k) => rom.r8(tiles + k) | (p << 8));
  const steps: Piece[][] = [], table = stepTable(rom);
  for (let e = 0; e < OW_EVENTS; e++) {
    const from = rom.r16(DIVIDERS + e * 2), to = rom.r16(DIVIDERS + e * 2 + 2);
    steps.push(Array.from({ length: Math.max(0, to - from) }, (_, k) => ({ at: rom.r16(table + (from + k) * 4), pos: rom.r16(table + (from + k) * 4 + 2) })));
  }
  const silent: Silent[][] = Array.from({ length: OW_EVENTS }, () => []);
  if (hasEventPatch(rom)) {
    const c = silentCode(rom), div = rom.r24(c + SILENT_DIV), t = rom.r24(c + SILENT_TILES), l = rom.r24(c + SILENT_LOCS), y = rom.r24(c + SILENT_LAYERS);
    for (let e = 0; e < OW_EVENTS; e++) {
      for (let x = rom.r16(div + e * 2); x < rom.r16(div + e * 2 + 2); x += 2) {
        silent[e].push({ layer: rom.r8(y + x / 2) & 1 ? 2 : 1, tile: rom.r16(t + x), loc: rom.r16(l + x) });
      }
    }
  } else {
    // the game looks its table through from the last entry down
    const g = GAME_SILENT;
    for (let k = g.count - 1; k >= 0; k--) {
      const e = rom.r8(g.events + k);
      if (e < OW_EVENTS) silent[e].push({ layer: rom.r8(g.layers + k) & 1 ? 2 : 1, tile: rom.r16(g.tiles + k * 2), loc: rom.r16(g.locs + k * 2) });
    }
  }
  return { area6, storage, steps, silent };
}

// writes piece p into the layer 2 map (readL2's layout)
export function drawPiece(l2: Uint16Array, d: EventData, p: Piece): void {
  pieceCells(p.pos, isBig(d, p.at)).forEach((i, k) => { if (i >= 0) l2[i] = d.storage[p.at + k] ?? 0; });
}
// the layer 2 pieces event e writes, in order: its steps, then its silent ones
export const eventPieces = (d: EventData, e: number): Piece[] =>
  [...d.steps[e], ...d.silent[e].filter((s) => s.layer === 2).map((s) => ({ at: s.tile, pos: s.loc }))];
// layer 2 as after events from … to-1 passed, in their number order, as the game draws them when a file is loaded
export function applyEvents(l2: Uint16Array, d: EventData, from: number, to: number): Uint16Array {
  const out = l2.slice();
  for (let e = from; e < to; e++) for (const p of eventPieces(d, e)) drawPiece(out, d, p);
  return out;
}

// ---- writing ----

// writes `data` into the block at `at` when it fits (a RATS block's size, or `room` bytes), else moves it to
// free space (with `slack` bytes of room) and returns the new address
function place(rom: Rom, at: number, data: Uint8Array, slack: number, room = -1): number {
  const pc = snesToPc(at), size = pc >= 0x80008 ? rom.isRatsAt(pc - 8) : -1;
  if (size >= data.length || (size < 0 && room >= data.length)) { rom.writeBytes(at, data); return at; }
  if (size >= 0) rom.freeAt(at);
  const payload = new Uint8Array(data.length + slack);
  payload.set(data);
  return rom.allocWrite(payload);
}
const words = (v: number[]) => Uint8Array.from(v.flatMap((w) => [w & 0xff, (w >> 8) & 0xff]));

// writes the steps, the storage and the silent steps (needs the patch); a table that didn't change keeps its bytes
export function writeEvents(rom: Rom, d: EventData): void {
  if (!hasEventPatch(rom)) missingPatch('Event steps (Lunar Magic format)');
  if (d.storage.length > STORAGE_MAX) throw new Error(`The event tiles need ${d.storage.length} of ${STORAGE_MAX} places`);
  const div: number[] = [0];
  for (const s of d.steps) div.push(div[div.length - 1] + s.length);
  rom.writeBytes(DIVIDERS, words(div));
  const steps = words(d.steps.flat().flatMap((p) => [p.at, p.pos]));
  const st = place(rom, stepTable(rom), steps, STEP_SLACK);
  STEP_OPS.forEach((a) => rom.w24(a, st));
  STEP_OPS2.forEach((a) => rom.w24(a, st + 2));
  const tiles = place(rom, tileTable(rom), Uint8Array.from(d.storage, (w) => w & 0xff), STORAGE_SLACK);
  rom.w8(TILE_BANK, tiles >> 16); rom.w16(TILE_LO, tiles & 0xffff); rom.w24(TILE_LONG, tiles);
  const props = place(rom, propTable(rom), rle1Encode(Array.from(d.storage, (w) => w >> 8)), STORAGE_SLACK);
  rom.w8(PROP_BANK, props >> 16); rom.w16(PROP_LO, props & 0xffff);
  AREA6_OPS.forEach((a) => rom.w16(a, d.area6));
  const c = silentCode(rom), all = d.silent.flat(), sdiv: number[] = [0];
  for (const s of d.silent) sdiv.push(sdiv[sdiv.length - 1] + s.length * 2);
  // a table never empty (an entry no event reaches, as Lunar Magic's)
  const pad = <T>(v: T[], none: T) => (v.length ? v : [none]);
  for (const [off, data] of [
    [SILENT_DIV, words(sdiv)],
    [SILENT_TILES, words(pad(all.map((s) => s.tile), 0))],
    [SILENT_LOCS, words(pad(all.map((s) => s.loc), 0))],
    [SILENT_LAYERS, Uint8Array.from(pad(all.map((s) => (s.layer === 2 ? 1 : 0)), 0))],
  ] as [number, Uint8Array][]) rom.w24(c + off, place(rom, rom.r24(c + off), data, SILENT_SLACK));
}

// the ROM bytes (PC offsets, [start, end)) of the event steps' tables
export function eventDataRanges(rom: Rom): [number, number][] {
  if (!hasEventPatch(rom)) return [];
  const block = (snes: number): [number, number] => { const pc = snesToPc(snes), n = rom.isRatsAt(pc - 8); return [pc, pc + Math.max(0, n)]; };
  const at = (snes: number, len: number): [number, number] => [snesToPc(snes), snesToPc(snes) + len];
  const c = silentCode(rom);
  return [
    at(DIVIDERS, (OW_EVENTS + 1) * 2), block(stepTable(rom)), block(tileTable(rom)), block(propTable(rom)),
    ...[SILENT_DIV, SILENT_TILES, SILENT_LOCS, SILENT_LAYERS].map((o) => block(rom.r24(c + o))),
    ...[...STEP_OPS, ...STEP_OPS2, TILE_LONG].map((a) => at(a, 3)), at(TILE_BANK, 1), at(TILE_LO, 2), at(PROP_LO, 2), at(PROP_BANK, 1),
    ...AREA6_OPS.map((a) => at(a, 2)), ...[SILENT_DIV, SILENT_TILES, SILENT_LOCS, SILENT_LAYERS].map((o) => at(c + o, 3)),
  ];
}

// ---- the patch ----
const hx = (n: number) => '$' + n.toString(16).toUpperCase();

const CODE_SIZE = 0x98;

const eventAsm = (code: number, t: { div: number; tiles: number; locs: number; layers: number }) => `lorom
; the silent steps of the event in A (8): from the game's $04E9F1 (when the overworld loads, $04DA49 – layer 1
; only, layer 2 is drawn with the file) and $04E9EC (an event ends); back at $04E9FC as after its loop
org ${hx(SILENT_HOOK)}
  JSL Silent : NOP
; a file loaded ($04DC6A): after an event's standard steps its silent ones, then the next event (A = $0F)
org ${hx(LOAD_HOOK)}
  JSL Load
org ${hx(LOAD_COUNT)}
  db ${hx(OW_EVENTS)}

org ${hx(code)}
Silent:
  PHP
  REP #$30
  PHY
  AND #$00FF : ASL : TAX
  LDY #$0004
- LDA.l ${hx(t.div)},x : STA $0002,y            ; $06 the event's first entry, $04 the next event's
  INX : INX : DEY : DEY : BNE -
  SEC : SBC $06 : BEQ .done
  TAY
  LDX $06
.next
  assert pc() == ${hx(code + SILENT_TILES - 1)}
  LDA.l ${hx(t.tiles)},x : STA $00
  assert pc() == ${hx(code + SILENT_LOCS - 1)}
  LDA.l ${hx(t.locs)},x : STA $04
  PHX
  TXA : LSR : TAX
  SEP #$20
  assert pc() == ${hx(code + SILENT_LAYERS - 1)}
  LDA.l ${hx(t.layers)},x : AND #$01 : BEQ .layer1
  LDA $09,s : CMP #$AB : BEQ .skip              ; called by $04DA49 ($04DAA9 JSR): the overworld loads
  PHY : PHP
  LDY $00
  PHK : PER .back-1 : PEA.w $8413               ; the game's piece ($04E4A9, Y the storage index, $04 the position), its RTS through an RTL
  JML $04E4A9
.back
  PLP : PLY
  BRA .skip
.layer1
  LDX $04
  LDA $00 : STA $7EC800,x
  LDA $01 : STA $7FC800,x
.skip
  REP #$20
  PLX : INX : INX
  DEY : DEY : BNE .next
.done
  PLY
  PLP
  RTL

Load:
  LDA $0F : AND #$07 : TAX
  LDA $0F : LSR #3 : TAY
  LDA $1F02,y : AND.l Bits,x : BEQ +
  LDA $0F : JSL Silent
+ INC $0F : LDA $0F
  RTL
Bits:
  db $80,$40,$20,$10,$08,$04,$02,$01
warnpc ${hx(code + CODE_SIZE)}
`;

// needs Asar (loadAsar) to be loaded; the clean game's steps, storage and silent steps in Lunar Magic's layout,
// and 0x78 events (the reveal tables extended with 8 that reveal nothing)
export function installEventPatch(rom: Rom): void {
  if (hasEventPatch(rom)) return;
  if (rom.r8(TL_COUNT - 1) !== 0xc9) throw new Error('The translevel table patch is needed first');
  const d = readEvents(rom);
  const reveal = rom.bytes(GAME_REVEAL, GAME_REVEALS * 2), vram = rom.bytes(GAME_REVEAL_VRAM, GAME_REVEALS * 2);
  const ext = (b: Uint8Array) => { const o = new Uint8Array(OW_EVENTS * 2); o.set(b); return o; };
  const revealAt = rom.allocWrite(ext(reveal)), vramAt = rom.allocWrite(ext(vram));
  REVEAL_OPS.forEach((a) => rom.w24(a, revealAt));
  rom.w24(REVEAL_VRAM_OP, vramAt);
  // the silent tables' first places (writeEvents moves them on), the code
  const one = () => rom.allocWrite(new Uint8Array(SILENT_SLACK));
  const t = { div: rom.allocWrite(new Uint8Array((OW_EVENTS + 1) * 2 + SILENT_SLACK)), tiles: one(), locs: one(), layers: one() };
  const code = rom.allocWrite(new Uint8Array(CODE_SIZE));
  const r = assemble(rom.data, new Map([['events.asm', eventAsm(code, t)]]), 'events.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  for (const [a, n] of [[SILENT_HOOK, 5], [LOAD_HOOK, 4], [LOAD_COUNT, 1], [code, CODE_SIZE]]) {
    rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
  }
  rom.w8(TL_COUNT, OW_EVENTS);
  writeEvents(rom, d);
}
