// ROM patches applied by the editor (hand-assembled 65816).

import { Rom } from './rom.ts';
import { SPR_BANK_TABLE_PTR } from './level.ts';

export function hasSpriteBankPatch(rom: Rom): boolean {
  return rom.r8(SPR_BANK_TABLE_PTR) === 0x22;
}

// Replaces `LDA #$07 : STA $D0` at $05D8F5 with a JSL to a routine that reads the
// sprite data bank from a 512-entry table, so sprite data can live in any bank.
export function applySpriteBankPatch(rom: Rom): void {
  if (hasSpriteBankPatch(rom)) return;
  if (rom.r8(SPR_BANK_TABLE_PTR) !== 0xa9 || rom.r8(SPR_BANK_TABLE_PTR + 1) !== 0x07) {
    throw new Error('Unerwarteter Code bei $05D8F5 – Sprite-Bank-Patch nicht möglich');
  }
  const code = [
    0x08, // PHP
    0xc2, 0x30, // REP #$30
    0x48, // PHA
    0xda, // PHX
    0x98, // TYA
    0x4a, // LSR
    0xaa, // TAX
    0xe2, 0x20, // SEP #$20
    0xbf, 0, 0, 0, // LDA.l table,x (patched below)
    0x85, 0xd0, // STA $D0
    0xc2, 0x20, // REP #$20
    0xfa, // PLX
    0x68, // PLA
    0x28, // PLP
    0x6b, // RTL
  ];
  const payload = new Uint8Array(3 + code.length + 512);
  payload.set(code, 3);
  payload.fill(0x07, 3 + code.length);
  const addr = rom.allocWrite(payload);
  const table = addr + 3 + code.length;
  const routine = addr + 3;
  rom.w24(addr, table);
  rom.w24(routine + 11, table);
  rom.w8(SPR_BANK_TABLE_PTR, 0x22);
  rom.w24(SPR_BANK_TABLE_PTR + 1, routine);
}

export function spriteBankTable(rom: Rom): number {
  return rom.r24(rom.r24(SPR_BANK_TABLE_PTR + 1) - 3);
}
