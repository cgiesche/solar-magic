// Writing an edited level back into the ROM.

import { Rom, snesToPc } from './rom.ts';
import {
  type Level, L1_PTRS, L2_PTRS, SPR_PTRS, serializeLayer1, serializeLayer2, serializeSprites, isL1Vertical,
  writeSecondaryHeader, spriteBank,
} from './level.ts';
import { applySpriteBankPatch, spriteBankTable } from './patches.ts';

function countRefs(rom: Rom, table: number, stride: number, addr: number, bankFn?: (i: number) => number): number {
  let n = 0;
  for (let i = 0; i < 512; i++) {
    const a = stride === 3 ? rom.r24(table + i * 3) : (bankFn!(i) << 16) | rom.r16(table + i * 2);
    if (a === addr) n++;
  }
  return n;
}

function place(rom: Rom, oldAddr: number, oldSize: number, shared: boolean, data: Uint8Array, bankLocked: number | null): number {
  if (!shared && data.length <= oldSize && (bankLocked === null || oldAddr >> 16 === bankLocked)) {
    rom.data.set(data, snesToPc(oldAddr));
    return oldAddr;
  }
  if (!shared) rom.freeAt(oldAddr);
  return rom.allocWrite(data);
}

export function saveLevel(rom: Rom, lv: Level): string[] {
  const log: string[] = [];
  const n = lv.number;
  // layer 1
  const l1 = serializeLayer1(rom, lv);
  const l1Shared = countRefs(rom, L1_PTRS, 3, lv.l1Addr) > 1;
  const a1 = place(rom, lv.l1Addr, lv.l1Size, l1Shared, l1, null);
  rom.w24(L1_PTRS + n * 3, a1);
  log.push(`Layer 1: ${l1.length} Bytes @ $${a1.toString(16).toUpperCase()}`);
  // layer 2
  const l2 = serializeLayer2(rom, lv);
  if (l2) {
    const old = rom.r24(L2_PTRS + n * 3);
    const shared = countRefs(rom, L2_PTRS, 3, old) > 1;
    const a2 = place(rom, old, lv.l2Size, shared, l2, null);
    rom.w24(L2_PTRS + n * 3, a2);
    log.push(`Layer 2: ${l2.length} Bytes @ $${a2.toString(16).toUpperCase()}`);
  } else {
    rom.w24(L2_PTRS + n * 3, lv.layer2Pointer);
  }
  // sprites
  const spr = serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode));
  const bankOf = (i: number) => spriteBank(rom, i);
  const sprShared = countRefs(rom, SPR_PTRS, 2, lv.sprAddr, bankOf) > 1;
  let as: number;
  if (!sprShared && spr.length <= lv.sprSize) {
    rom.data.set(spr, snesToPc(lv.sprAddr));
    as = lv.sprAddr;
  } else {
    applySpriteBankPatch(rom);
    if (!sprShared) rom.freeAt(lv.sprAddr);
    as = rom.allocWrite(spr);
  }
  rom.w16(SPR_PTRS + n * 2, as & 0xffff);
  if ((as >> 16) !== 0x07 || rom.r8(0x05d8f5) === 0x22) {
    applySpriteBankPatch(rom);
    rom.w8(spriteBankTable(rom) + n, as >> 16);
  }
  log.push(`Sprites: ${spr.length} Bytes @ $${as.toString(16).toUpperCase()}`);
  writeSecondaryHeader(rom, n, lv.secondary);
  return log;
}
