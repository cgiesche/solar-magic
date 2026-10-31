// Writing an edited level back into the ROM.

import { Rom } from './rom.ts';
import {
  type Level, L1_PTRS, L2_PTRS, SPR_PTRS, serializeLayer1, serializeLayer2, serializeLevelSprites, isL1Vertical, spriteSizes,
  writeSecondaryHeader, spriteBank, storedBgAddr,
} from './level.ts';
import { setSpriteBank, bgBank, setBgBank } from './patches.ts';
import { encodeBg } from './bg.ts';
import { saveLayer3 } from './layer3map.ts';

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
    rom.writeBytes(oldAddr, data);
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
  log.push(`Layer 1: ${l1.length} bytes @ $${a1.toString(16).toUpperCase()}`);
  // layer 2
  const l2 = serializeLayer2(rom, lv);
  if (l2) {
    const old = rom.r24(L2_PTRS + n * 3);
    const shared = countRefs(rom, L2_PTRS, 3, old) > 1;
    const a2 = place(rom, old, lv.l2Size, shared, l2, null);
    rom.w24(L2_PTRS + n * 3, a2);
    log.push(`Layer 2: ${l2.length} bytes @ $${a2.toString(16).toUpperCase()}`);
  } else {
    // BG tilemap: edited data goes to free space (bank via BG patch); a changed pointer drops old custom data
    // (a bank entry behind a pointer of no BG tilemap is dropped too, else a new BG pointer would read from its bank)
    const old = rom.r24(L2_PTRS + n * 3), oldBg = storedBgAddr(rom, n);
    if (bgBank(rom, n) && (lv.bg || lv.layer2Pointer !== old)) {
      const users = oldBg ? Array.from({ length: 512 }, (_, i) => i).filter((i) => storedBgAddr(rom, i) === oldBg) : [];
      if (users.length === 1) rom.freeAt(oldBg);
      setBgBank(rom, n, 0);
    }
    if (lv.bg) {
      const data = encodeBg(lv.bg);
      const a = rom.allocWrite(data);
      setBgBank(rom, n, a >> 16);
      rom.w24(L2_PTRS + n * 3, 0xff0000 | (a & 0xffff));
      log.push(`BG: ${data.length} bytes @ $${a.toString(16).toUpperCase()}`);
    } else rom.w24(L2_PTRS + n * 3, lv.layer2Pointer);
  }
  log.push(saveSprites(rom, lv));
  writeSecondaryHeader(rom, n, lv.secondary);
  // the layer 3 tilemap is the LT3 file's, which the Graphics tab can change: saved once, then read from there
  if (lv.layer3) { log.push(saveLayer3(rom, n, lv.layer3)); lv.layer3 = null; }
  return log;
}

// writes a level's sprite data (in place when it fits and no other level uses it)
export function saveSprites(rom: Rom, lv: Level): string {
  const n = lv.number;
  const spr = serializeLevelSprites(rom, lv);
  const bankOf = (i: number) => spriteBank(rom, i);
  const sprShared = countRefs(rom, SPR_PTRS, 2, lv.sprAddr, bankOf) > 1;
  let as: number;
  if (!sprShared && spr.length <= lv.sprSize) {
    rom.writeBytes(lv.sprAddr, spr);
    as = lv.sprAddr;
  } else {
    if (!sprShared) rom.freeAt(lv.sprAddr);
    as = rom.allocWrite(spr);
  }
  rom.w16(SPR_PTRS + n * 2, as & 0xffff);
  setSpriteBank(rom, n, as >> 16);
  lv.sprAddr = as;
  lv.sprSize = spr.length;
  return `Sprites: ${spr.length} bytes @ $${as.toString(16).toUpperCase()}`;
}
