// Overworld data (vanilla formats) and emulation-based loading of OW graphics.

import { Rom, snesToPc } from './rom.ts';
import { Snes, type SnesState } from './snes.ts';
import { rleDecode, rleEncode } from './rle.ts';

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

export const MAP_NAMES = ['Hauptkarte', "Yoshi's Island", 'Vanilla Dome', 'Forest of Illusion', 'Valley of Bowser', 'Special World', 'Star World'];

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

export function writeL2(rom: Rom, entries: Uint16Array): number {
  const t = rleEncode(Array.from(entries, (v) => v & 0xff));
  const a = rleEncode(Array.from(entries, (v) => v >> 8));
  const payload = new Uint8Array(t.length + a.length);
  payload.set(t);
  payload.set(a, t.length);
  const old = l2Pointers(rom);
  rom.freeAt(old.tiles);
  const addr = rom.allocWrite(payload);
  rom.w16(L2_TILE_PTR, addr & 0xffff);
  rom.w16(L2_ATTR_PTR, (addr + t.length) & 0xffff);
  rom.w8(L2_BANK, addr >> 16);
  return payload.length;
}

// vanilla: level tiles ($56-$80) get translevel numbers in scan order
export function isLevelTile(t: number): boolean {
  return t >= 0x56 && t < 0x81;
}
export function translevels(l1: Uint8Array): Uint8Array {
  const out = new Uint8Array(0x800);
  let n = 1;
  for (let i = 0; i < 0x800; i++) if (isLevelTile(l1[i])) out[i] = n++;
  return out;
}
export function translevelToLevel(t: number): number {
  return t < 0x25 ? t : t + 0xdc;
}

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
  constructor(rom: Rom) {
    this.rom = rom;
    this.snes = new Snes(rom.data);
  }
  load(map: number, allEvents: boolean): OwRender {
    const s = this.snes;
    s.rom = this.rom.data;
    if (!this.titleState) {
      s.reset();
      let f = 0;
      while (s.wram[0x100] !== 0x07 && f++ < 2000) s.runFrame();
      this.titleState = s.saveState();
    } else s.loadState(this.titleState);
    const w = s.wram;
    let n = 0;
    try {
      while (w[0x100] !== 0x0e && n < 1500) {
        if (w[0x100] === 0x0b) {
          w[0x109] = 0;
          w[0x1f11] = map;
          w[0x1f12] = map;
          if (allEvents) for (let i = 0; i < 15; i++) w[0x1f02 + i] = 0xff;
        }
        s.joy1 = (n % 16) < 4 ? (w[0x100] === 0x07 ? 0x1000 : 0x0080) : 0;
        s.runFrame();
        n++;
      }
      s.joy1 = 0;
      for (let i = 0; i < 3; i++) s.runFrame();
    } catch {
      return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: false };
    }
    return { vram: s.vram.slice(), cgram: s.cgram.slice(), wram: s.wram.slice(), ppuRegs: s.ppuRegs.slice(), ok: w[0x100] === 0x0e };
  }
}
