// Overworld data (vanilla formats) and emulation-based loading of OW graphics.

import { Rom, snesToPc } from './rom.ts';
import { Snes, type SnesState } from './snes.ts';
import { RomReads, updateBytePages } from './romdeps.ts';
import { rleDecode, rleEncode } from './rle.ts';
import { GM, RAM } from './ram.ts';
import { assemble } from './asar.ts';
import { lz2Compress, lz2Decompress } from './lz2.ts';

export const OW_L1 = 0x0cf7df; // 0x800 bytes: 2 maps × 32×32 16x16 tiles (quadrant layout)
const L2_TILE_PTR = 0x04dc72; // LDA #$A533 operand
const L2_BANK = 0x04dc79; // LDA #$04 operand (shared bank of both streams)
const L2_ATTR_PTR = 0x04dc8d; // LDA #$C02B operand
export const NAME_CODES = 0x04a0fc; // 16-bit per translevel
const NAME_CHARS = 0x049ac5;
const NAME_P1 = 0x049c91; // 31 entries
const NAME_P2 = 0x049ccf; // 15 entries
const NAME_P3 = 0x049ced; // 10 entries
export const NAME_PART_COUNTS = [31, 15, 10];

export const MAP_NAMES = ['Main map', "Yoshi's Island", 'Vanilla Dome', 'Forest of Illusion', 'Valley of Bowser', 'Special World', 'Star World'];

export function l1Index(map: number, x: number, y: number): number {
  return map * 0x400 + ((y >> 4) * 2 + (x >> 4)) * 0x100 + (y & 15) * 16 + (x & 15);
}
export function l2Index(map: number, x: number, y: number): number {
  return map * 0x1000 + ((y >> 5) * 2 + (x >> 5)) * 0x400 + (y & 31) * 32 + (x & 31);
}

export function readL1(rom: Rom): Uint8Array {
  return rom.bytes(OW_L1, 0x800);
}
export function writeL1(rom: Rom, d: Uint8Array): void {
  rom.writeBytes(OW_L1, d);
}

export function l2Pointers(rom: Rom): { tiles: number; attrs: number } {
  const bank = rom.r8(L2_BANK);
  return { tiles: (bank << 16) | rom.r16(L2_TILE_PTR), attrs: (bank << 16) | rom.r16(L2_ATTR_PTR) };
}

export function readL2(rom: Rom): Uint16Array {
  const out = new Uint16Array(0x2000);
  const p = l2Pointers(rom);
  rleDecode(rom.data, snesToPc(p.tiles), out, 0, 0x2000);
  rleDecode(rom.data, snesToPc(p.attrs), out, 8, 0x2000);
  return out;
}

// free space a moved layer 2 gets between its two streams, so that later strokes still fit in its block
const L2_SLACK = 0x200;

// Writes layer 2 where it is when it fits: a stream that didn't change keeps its bytes, one that did is written in
// its own space (the tile stream up to the attribute stream, the attribute stream up to the end of its RATS block or
// its old length); else both go to the space from the tile stream on (the attributes at its end), else to free space.
// Returns the bytes of the two streams.
export function writeL2(rom: Rom, entries: Uint16Array): number {
  const old = l2Pointers(rom), d = rom.data;
  const oldT = new Uint16Array(0x2000), oldA = new Uint16Array(0x2000);
  const tLen = rleDecode(d, snesToPc(old.tiles), oldT, 0, 0x2000);
  const aLen = rleDecode(d, snesToPc(old.attrs), oldA, 0, 0x2000);
  const stream = (shift: number, was: Uint16Array, at: number, len: number) => {
    const v = Array.from(entries, (e) => (e >> shift) & 0xff);
    return v.every((b, i) => b === was[i]) ? d.slice(snesToPc(at), snesToPc(at) + len) : Uint8Array.from(rleEncode(v));
  };
  const t = stream(0, oldT, old.tiles, tLen), a = stream(8, oldA, old.attrs, aLen);
  const rats = old.attrs > old.tiles ? rom.isRatsAt(snesToPc(old.tiles) - 8) : -1;
  const end = rats > 0 ? old.tiles + rats : old.attrs + aLen;
  const tRoom = old.attrs > old.tiles ? old.attrs - old.tiles : tLen;
  if (t.length <= tRoom && a.length <= end - old.attrs) {
    rom.writeBytes(old.tiles, t);
    rom.writeBytes(old.attrs, a);
  } else if (old.attrs > old.tiles && t.length + a.length <= end - old.tiles) {
    rom.writeBytes(old.tiles, t);
    rom.writeBytes(end - a.length, a);
    rom.w16(L2_ATTR_PTR, (end - a.length) & 0xffff);
  } else {
    const payload = new Uint8Array(t.length + L2_SLACK + a.length);
    payload.set(t);
    payload.set(a, t.length + L2_SLACK);
    rom.freeAt(old.tiles);
    const addr = rom.allocWrite(payload);
    rom.w16(L2_TILE_PTR, addr & 0xffff);
    rom.w16(L2_ATTR_PTR, (addr + t.length + L2_SLACK) & 0xffff);
    rom.w8(L2_BANK, addr >> 16);
  }
  return t.length + a.length;
}

// ---- level tiles and their translevels ----
// Level tiles and the translevel each enters, stored per tile in Lunar Magic's translevel table (ADR 0005): the
// game numbers the level tiles by scanning layer 1 ($04D7F2, scanTranslevels), so placing one shifts every later
// level's number, name, base event and flags. Lunar Magic replaces the scan with a table of the 0x800 tiles'
// translevels, LC_LZ2 compressed and decompressed to $7ED000 (its pointer at $04D803, bank at $04D808 –
// Ankouno's OverworldTables.asm); the patch writes its own code there in that layout. The rest of the game's
// routine stays: each level tile's initial flags ($04D678 by translevel) to $7ED800, then the passed events.
// Translevel 0 is no level (the scan starts at 1); a level tile has one, any other tile 0.

export function isLevelTile(t: number): boolean {
  return t >= 0x56 && t < 0x81;
}
// the game's numbering: the level tiles in scan order from 1
export function scanTranslevels(l1: Uint8Array): Uint8Array {
  const out = new Uint8Array(0x800);
  let n = 1;
  for (let i = 0; i < 0x800; i++) if (isLevelTile(l1[i])) out[i] = n++;
  return out;
}
export function translevelToLevel(t: number): number {
  return t < 0x25 ? t : t + 0xdc;
}

const HOOK = 0x04d7f2, HOOK_END = 0x04d85d;
const PTR = 0x04d803; // LDA #$xxxx operand: the table's address
const BANK = 0x04d808; // LDA #$xx operand: its bank
export const TILES = 0x800;
export const MAX_TRANSLEVEL = 0x5f; // level 13B
const SLACK = 0x40; // free bytes after the table in its block, so that later changes still fit

const asm = `lorom
org $${HOOK.toString(16)}
  PHB
  SEP #$20 : REP #$10
  LDY #$D000 : STY $00 : LDA #$7E : STA $02     ; to $7ED000
  REP #$20
  assert pc() == $04D802
  LDA.w #$0000 : STA $8A                       ; the table (written by the editor)
  assert pc() == $04D807
  LDA.w #$0000 : STA $8C
  SEP #$20
  LDA #$00 : PHA : PLB
  PHK : PEA.w Decompressed-1 : PEA.w $804C     ; the game's decompression (RTS) through an RTL of bank 0
  JML $00B8DE
Decompressed:
  PLB
  REP #$30 : LDA #$0000 : SEP #$20
  LDA #$00 : STA $0A : LDA #$D8 : STA $0B : LDA #$7E : STA $0C   ; $7ED800 as the game's
  LDY #$07FF
- TYX
  LDA.l $7ED000,x : BEQ +
  TAX : LDA.l $04D678,x                        ; the translevel's initial flags
+ STA [$0A],y
  DEY : BPL -
  STZ $0F                                      ; the passed events, as the game's
- JSR $DA49
  INC $0F : LDA $0F : CMP #$6F : BNE -
  RTS
warnpc $${HOOK_END.toString(16)}
`;

export function hasTranslevelTable(rom: Rom): boolean {
  return rom.r8(PTR - 1) === 0xa9 && rom.r8(BANK - 1) === 0xa9;
}
const tableAt = (rom: Rom) => (rom.r8(BANK) << 16) | rom.r16(PTR);

// the translevel of every layer 1 tile (l1Index order); a ROM without the table numbers them as the game does
export function readTranslevels(rom: Rom): Uint8Array {
  if (!hasTranslevelTable(rom)) return scanTranslevels(readL1(rom));
  const out = new Uint8Array(TILES);
  out.set(lz2Decompress(rom.data, snesToPc(tableAt(rom))).data.subarray(0, TILES));
  return out;
}

// writes the table where it is when it fits its block, else to free space; unchanged: nothing written
export function writeTranslevels(rom: Rom, t: Uint8Array): void {
  const at = tableAt(rom); // 0: the patch being installed
  if (at && readTranslevels(rom).every((v, i) => v === t[i])) return;
  const packed = lz2Compress(t);
  const room = at && snesToPc(at) >= 0x80008 ? rom.isRatsAt(snesToPc(at) - 8) : -1;
  if (packed.length <= room) { rom.writeBytes(at, packed); return; }
  if (at) rom.freeAt(at);
  const payload = new Uint8Array(packed.length + SLACK);
  payload.set(packed);
  const addr = rom.allocWrite(payload);
  rom.w16(PTR, addr & 0xffff);
  rom.w8(BANK, addr >> 16);
}

// needs Asar (loadAsar) to be loaded; every level tile gets the translevel the game's scan gives it
export function installTranslevelPatch(rom: Rom): void {
  if (hasTranslevelTable(rom)) return;
  const t = scanTranslevels(readL1(rom));
  const r = assemble(rom.data, new Map([['translevels.asm', asm]]), 'translevels.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  rom.writeAt(snesToPc(HOOK), r.rom.subarray(snesToPc(HOOK), snesToPc(HOOK_END)));
  writeTranslevels(rom, t);
}

// the lowest translevel no tile enters (0: all are entered)
export function freeTranslevel(t: Uint8Array): number {
  const used = new Set(t);
  for (let n = 1; n <= MAX_TRANSLEVEL; n++) if (!used.has(n)) return n;
  return 0;
}

// paints tile v at i (l1 and t changed): a level tile takes `carried` (the translevel it was picked up from the
// map with), else keeps the one there (a level tile painted over), else gets a free one; any other tile none,
// so the translevel of a level tile painted over is free again
export function placeTile(l1: Uint8Array, t: Uint8Array, i: number, v: number, carried = 0): void {
  l1[i] = v;
  if (!isLevelTile(v)) t[i] = 0;
  else if (carried) t[i] = carried;
  else if (!t[i]) t[i] = freeTranslevel(t);
}

// the translevels more than one level tile enters, with their tiles
export function sharedTranslevels(l1: Uint8Array, t: Uint8Array): Map<number, number[]> {
  const tiles = new Map<number, number[]>();
  t.forEach((n, i) => { if (n && isLevelTile(l1[i])) (tiles.get(n) ?? tiles.set(n, []).get(n)!).push(i); });
  for (const [n, l] of tiles) if (l.length < 2) tiles.delete(n);
  return tiles;
}

// the levels a level tile can enter (001–024, 101–13B), by translevel
export const enterableLevels = (): { translevel: number; level: number }[] =>
  Array.from({ length: MAX_TRANSLEVEL }, (_, k) => ({ translevel: k + 1, level: translevelToLevel(k + 1) }));

// ---- level names ----
const CHARMAP: Record<number, string> = { 0x1f: ' ', 0x5d: "'", 0x5a: '#', 0x1c: '-', 0x1b: '!', 0x1d: '.' };
for (let i = 0; i < 26; i++) CHARMAP[i] = String.fromCharCode(65 + i);
for (let i = 0; i < 9; i++) CHARMAP[0x64 + i] = String(i + 1);

export function nameWord(rom: Rom, part: number, idx: number): string {
  const table = [NAME_P1, NAME_P2, NAME_P3][part];
  const off = rom.r16(table + idx * 2);
  let s = '';
  for (let i = 0; i < 40; i++) {
    const b = rom.r8(NAME_CHARS + off + i);
    const c = b & 0x7f;
    s += CHARMAP[c] ?? '·';
    if (b & 0x80) break;
  }
  return s;
}
export function nameCode(rom: Rom, translevel: number): number {
  return rom.r16(NAME_CODES + translevel * 2);
}
export function setNameCode(rom: Rom, translevel: number, code: number): void {
  rom.w16(NAME_CODES + translevel * 2, code);
}
export function splitNameCode(code: number): [number, number, number] {
  return [(code >> 8) & 0x7f, (code >> 4) & 0x0f, code & 0x0f];
}
export function joinNameCode(p: [number, number, number]): number {
  return ((p[0] & 0x7f) << 8) | ((p[1] & 15) << 4) | (p[2] & 15);
}
export function levelName(rom: Rom, translevel: number): string {
  const [a, b, c] = splitNameCode(nameCode(rom, translevel));
  return (nameWord(rom, 0, a) + nameWord(rom, 1, b) + nameWord(rom, 2, c)).replace(/\s+/g, ' ').trim();
}

// ---- events ----
// per translevel: the event its normal exit runs (the secret exit's the next one; $FF none), $1DEA (ram.ts)
export const BASE_EVENTS = 0x05d608;
export const OW_EVENTS = 0x78; // 15 bytes of event bits
export const baseEvent = (rom: Rom, tl: number): number => rom.r8(BASE_EVENTS + tl);
// the overworld's events by the level exits that run them ("105 YOSHI'S ISLAND 1 – normal exit"), of the levels on
// the map; an event no normal exit runs by the secret exits that do (the game numbers a level's events one after
// the other: after one without a secret exit its next event is the next level's)
export function eventNames(rom: Rom): Map<number, string> {
  const normal = new Map<number, string[]>(), secret = new Map<number, string[]>();
  const add = (m: Map<number, string[]>, e: number, n: string) => { if (e < OW_EVENTS) (m.get(e) ?? m.set(e, []).get(e)!).push(n); };
  const tls = [...new Set(readTranslevels(rom))].filter((t) => t).sort((a, b) => a - b);
  for (const tl of tls) {
    const b = baseEvent(rom, tl);
    if (b >= OW_EVENTS) continue;
    const name = `${translevelToLevel(tl).toString(16).toUpperCase().padStart(3, '0')} ${levelName(rom, tl)}`;
    add(normal, b, `${name} – normal exit`);
    add(secret, b + 1, `${name} – secret exit`);
  }
  const out = new Map<number, string>();
  for (let e = 0; e < OW_EVENTS; e++) {
    const n = normal.get(e) ?? secret.get(e) ?? [];
    if (n.length) out.set(e, n.join(' · '));
  }
  return out;
}

// ---- emulation: load the overworld to obtain VRAM / CGRAM / Map16 tables ----
export interface OwRender {
  vram: Uint8Array;
  cgram: Uint8Array;
  wram: Uint8Array;
  ppuRegs: Uint8Array;
  ok: boolean;
}

export class OverworldEmulator {
  rom: Rom;
  snes: Snes;
  titleState: SnesState | null = null;
  private title: { reads: RomReads; rom: Uint8Array } | null = null; // what reaching the title screen read
  private romGen: number;
  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
    this.romGen = rom.gen;
  }
  // catches up with a changed ROM (rom.gen); a change of what reaching the title screen read makes its
  // snapshot stale (as LevelEmulator's boot snapshot)
  private sync(): void {
    this.snes.rom = this.rom.data;
    if (this.romGen === this.rom.gen) return;
    this.romGen = this.rom.gen;
    if (this.title?.reads.differ(this.title.rom, this.rom.data)) { this.titleState = null; this.title = null; }
  }
  load(map: number, allEvents: boolean): OwRender {
    this.sync();
    const s = this.snes;
    if (!this.titleState) {
      updateBytePages(this.rom);
      const reads = new RomReads(this.rom.data.length);
      s.romReads = reads;
      try {
        s.reset();
        let f = 0;
        while (s.wram[RAM.gameMode] !== GM.title && f++ < 2000) s.runFrame();
      } finally { s.romReads = null; }
      this.titleState = s.saveState();
      this.title = { reads, rom: this.rom.data.slice() };
    } else s.loadState(this.titleState);
    const w = s.wram;
    let n = 0;
    try {
      while (w[RAM.gameMode] !== GM.overworld && n < 1500) {
        if (w[RAM.gameMode] === GM.overworldLoad) {
          w[RAM.introLevel] = 0;
          w[RAM.submap] = map;
          w[RAM.submap + 1] = map;
          if (allEvents) for (let i = 0; i < 15; i++) w[RAM.owEvents + i] = 0xff;
        }
        s.joy1 = (n % 16) < 4 ? (w[RAM.gameMode] === GM.title ? 0x1000 : 0x0080) : 0;
        s.runFrame();
        n++;
      }
      s.joy1 = 0;
      for (let i = 0; i < 3; i++) s.runFrame();
    } catch {
      return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: false };
    }
    return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: w[RAM.gameMode] === GM.overworld };
  }
}
