// The emulator's memory timing (#152), in master cycles: a bus access costs what the SNES memory map says
// (WRAM and slow ROM 8, most I/O registers 6, $4000–$41FF 12), an internal cycle 6, a scanline 1364 of
// which DRAM refresh takes 40, and the lines run at fixed times (a long DMA takes the lines it lasts).
import { Snes, LINES_PER_FRAME, MASTER_PER_LINE } from '../src/core/snes.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// a LoROM image with code at $00:8000 (the reset vector)
const romWith = (code: number[]) => {
  const rom = new Uint8Array(0x80000);
  rom.set(code, 0);
  rom[0x7ffc] = 0x00; rom[0x7ffd] = 0x80;
  return rom;
};

// 1. one instruction's master cycles
{
  const time = (code: number[]) => {
    const s = new Snes(romWith(code));
    s.reset();
    const c0 = s.cpu.cycles;
    s.cpu.step();
    return s.cpu.cycles - c0;
  };
  const cases: [string, number[], number][] = [
    ['NOP: a fetch and an internal cycle', [0xea], 8 + 6],
    ['LDA $0000: WRAM', [0xad, 0x00, 0x00], 3 * 8 + 8],
    ['LDA $8000: slow ROM', [0xad, 0x00, 0x80], 3 * 8 + 8],
    ['LDA $4214: an I/O register', [0xad, 0x14, 0x42], 3 * 8 + 6],
    ['LDA $213F: a PPU register', [0xad, 0x3f, 0x21], 3 * 8 + 6],
    ['LDA $4016: the slow window', [0xad, 0x16, 0x40], 3 * 8 + 12],
    ['LDA $6000: expansion', [0xad, 0x00, 0x60], 3 * 8 + 8],
    ['INX: an internal cycle', [0xe8], 8 + 6],
    ['RTS: three internal cycles', [0x60], 8 + 2 * 8 + 3 * 6],
  ];
  for (const [what, code, want] of cases) {
    const t = time(code);
    check(t === want, `${what}: ${want} master cycles (${t})`);
  }
}

// 2. a frame: 262 lines of 1364 master cycles, 40 of each taken by DRAM refresh
{
  // CLC XCE REP #$20; loop: INC $10 (16-bit: 2 fetches, 2 reads, an internal cycle, 2 writes = 54); BRA loop (22): 76 master cycles an iteration
  const s = new Snes(romWith([0x18, 0xfb, 0xc2, 0x20, 0xe6, 0x10, 0x80, 0xfc]));
  s.reset();
  const count = () => s.wram[0x10] | (s.wram[0x11] << 8);
  s.runFrame();
  const n0 = count(), c0 = s.cpu.cycles;
  s.runFrame();
  const n = (count() - n0) & 0xffff, c = s.cpu.cycles - c0;
  const want = LINES_PER_FRAME * (MASTER_PER_LINE - 40) / 76;
  check(MASTER_PER_LINE === 1364, `a line: 1364 master cycles (${MASTER_PER_LINE})`);
  check(Math.abs(n - want) < 2, `iterations in a frame: ${want.toFixed(1)} (${n})`);
  check(Math.abs(c - LINES_PER_FRAME * MASTER_PER_LINE) < 76, `a frame: ${LINES_PER_FRAME * MASTER_PER_LINE} master cycles (${c})`);
}

// 3. a DMA of 0x4000 bytes (8 master cycles each) takes the lines it lasts: the frame keeps its length,
// the CPU runs less in it
{
  // DMA set up from $7E:0000 to $2180 (WMDATA), 0x4000 bytes, started once at the frame's beginning
  const code = [
    0xa9, 0x00, 0x8d, 0x00, 0x43, // LDA #$00 STA $4300 (A→B, 1 register)
    0xa9, 0x80, 0x8d, 0x01, 0x43, // LDA #$80 STA $4301 ($2180)
    0x9c, 0x02, 0x43, 0x9c, 0x03, 0x43, // STZ $4302/3
    0xa9, 0x7e, 0x8d, 0x04, 0x43, // bank $7E
    0x9c, 0x05, 0x43, 0xa9, 0x40, 0x8d, 0x06, 0x43, // count $4000
    0xa9, 0x01, 0x8d, 0x0b, 0x42, // MDMAEN
    0x18, 0xfb, 0xc2, 0x20, 0xe6, 0x10, 0x80, 0xfc, // CLC XCE REP #$20; loop: INC $10; BRA loop
  ];
  const s = new Snes(romWith(code));
  s.reset();
  const count = () => s.wram[0x10] | (s.wram[0x11] << 8);
  s.runFrame();
  const withDma = count(), c1 = s.cpu.cycles;
  s.runFrame();
  const plain = count() - withDma, c2 = s.cpu.cycles;
  const lost = plain - withDma;
  const want = 0x4000 * 8 / 76;
  check(Math.abs(lost - want) < 30, `the DMA's frame ran ${want.toFixed(0)} iterations fewer (${lost})`);
  check(Math.abs(c2 - c1 - LINES_PER_FRAME * MASTER_PER_LINE) < 76, `the frame after it at its time (${c2 - c1})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
