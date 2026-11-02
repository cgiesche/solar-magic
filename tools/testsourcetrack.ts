// Source tracking (load with trackSources, colorsources.ts): where each CGRAM color was loaded from is carried through the
// CPU's registers, the stack, WRAM and DMA with the bytes themselves – not guessed by matching the
// written value against values read before, which named a wrong place for a color whose value equals
// another byte read shortly before (#199).
import { Rom, snesToPc } from '../src/core/rom.ts';
import { Snes } from '../src/core/snes.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { SHARED_PALETTES, SHARED_COLORS } from '../src/core/sharedpal.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 4) => v < 0 ? '-' : v.toString(16).toUpperCase().padStart(n, '0');

// ---------- a program moving colors of equal values ----------
// Six colors, all $1234, each from its own place in the table at $00:9000 (ROM offsets $1000–$1011, all $1234).
{
  const rom = new Uint8Array(0x8000);
  const code = [
    0x18, 0xfb, // CLC : XCE
    0xc2, 0x30, // REP #$30
    // color 0: X's copy through the stack, while A holds the same value from another place
    0xad, 0x00, 0x90, // LDA $9000
    0xae, 0x02, 0x90, // LDX $9002
    0xda, 0x68, // PHX : PLA
    0x8f, 0x00, 0x00, 0x7e, // STA $7E0000
    // color 1: changed and changed back: computed, no source
    0xad, 0x00, 0x90, // LDA $9000
    0x1a, 0x3a, // INC A : DEC A
    0x8f, 0x02, 0x00, 0x7e, // STA $7E0002
    // color 2: through Y and X while A holds another value
    0xad, 0x04, 0x90, // LDA $9004
    0xa8, // TAY
    0xa9, 0x00, 0x00, // LDA #$0000
    0xbb, 0x8a, // TYX : TXA
    0x8f, 0x04, 0x00, 0x7e, // STA $7E0004
    // color 3: block move from the table
    0xa2, 0x06, 0x90, // LDX #$9006
    0xa0, 0x06, 0x00, // LDY #$0006
    0xa9, 0x01, 0x00, // LDA #$0001
    0x54, 0x7e, 0x00, // MVN $7E,$00
    // color 4: 8-bit halves, swapped with XBA
    0xe2, 0x20, // SEP #$20
    0xaf, 0x09, 0x90, 0x00, // LDA $009009
    0xeb, // XBA
    0xaf, 0x08, 0x90, 0x00, // LDA $009008
    0x8f, 0x08, 0x00, 0x7e, // STA $7E0008
    0xeb, // XBA
    0x8f, 0x09, 0x00, 0x7e, // STA $7E0009
    // colors 0-4 by DMA from WRAM to CGRAM
    0xa9, 0x00, 0x8f, 0x21, 0x21, 0x00, // LDA #$00 : STA $002121
    0xc2, 0x20, // REP #$20
    0xa9, 0x00, 0x22, 0x8f, 0x00, 0x43, 0x00, // LDA #$2200 : STA $004300
    0xa9, 0x00, 0x00, 0x8f, 0x02, 0x43, 0x00, // LDA #$0000 : STA $004302
    0xa9, 0x7e, 0x00, 0x8f, 0x04, 0x43, 0x00, // LDA #$007E : STA $004304
    0xa9, 0x0a, 0x00, 0x8f, 0x05, 0x43, 0x00, // LDA #$000A : STA $004305
    0xe2, 0x20, 0xa9, 0x01, 0x8f, 0x0b, 0x42, 0x00, // SEP #$20 : LDA #$01 : STA $00420B
    // color 5: written by the CPU, low byte then high byte
    0xc2, 0x20, 0xaf, 0x0a, 0x90, 0x00, // REP #$20 : LDA $00900A
    0xe2, 0x20, 0x8f, 0x22, 0x21, 0x00, // SEP #$20 : STA $002122
    0xeb, 0x8f, 0x22, 0x21, 0x00, // XBA : STA $002122
    // a 16-bit store whose low byte goes to ROM (no tag): the high byte still carries the high byte's source
    0xc2, 0x20, 0xaf, 0x0c, 0x90, 0x00, // REP #$20 : LDA $00900C
    0x8f, 0xff, 0xff, 0x7d, // STA $7DFFFF (high byte to $7E0000)
    // X loaded 16 bits wide, then made 8 bits wide: its low byte keeps its source
    0x4b, 0xab, // PHK : PLB
    0xc2, 0x10, 0xae, 0x0e, 0x90, // REP #$10 : LDX $900E
    0xe2, 0x10, 0x8e, 0x10, 0x00, // SEP #$10 : STX $0010
    0xdb, // STP
  ];
  rom.set(code, 0);
  for (let i = 0; i < 9; i++) rom.set([0x34, 0x12], 0x1000 + i * 2);
  rom[0x7ffc] = 0x00; rom[0x7ffd] = 0x80;
  const run = (track: boolean) => {
    const s = new Snes(rom);
    s.trackSources(track);
    s.powerOn();
    for (let n = 0; n < 1000 && !s.cpu.stopped; n++) s.cpu.step();
    s.trackSources(false);
    return s;
  };
  const s = run(true);
  check(s.cpu.stopped && [...Array(6).keys()].every((c) => s.cgram[c * 2] === 0x34 && s.cgram[c * 2 + 1] === 0x12), 'the program ran: six colors $1234');
  const src = (c: number) => `${hx(s.cgTaint[c * 2])} ${hx(s.cgTaint[c * 2 + 1])}`;
  const want = ['1002 1003', '- -', '1004 1005', '1006 1007', '1008 1009', '100A 100B'];
  const what = ['X through the stack, A holding the same value', 'changed and changed back', 'through Y and X', 'block move', 'halves swapped with XBA', 'written by the CPU'];
  for (let c = 0; c < 6; c++) check(src(c) === want[c], `color ${c}, ${what[c]}: ${src(c)}${src(c) === want[c] ? '' : ` (want ${want[c]})`}`);
  check(s.wram[0] === 0x12 && s.taint[0] === 0x100d, `a 16-bit store's high byte after one without a tag: from ${hx(s.taint[0])} (want 100D)`);
  check(s.wram[0x10] === 0x34 && s.taint[0x10] === 0x100e, `X's low byte after SEP #$10: from ${hx(s.taint[0x10])} (want 100E)`);
  const plain = run(false);
  check(plain.cgram.every((v, i) => v === s.cgram[i]) && plain.wram.every((v, i) => v === s.wram[i]) && plain.cpu.cycles === s.cpu.cycles,
    'without tracking the program runs the same');
}

// ---------- level 105 ----------
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
emu.boot();
// SNES address each color is loaded from (-1 none), as the palette tab takes it
const sources = (): number[] => {
  const r = emu.load(0x105, { trackSources: true });
  return Array.from({ length: 256 }, (_, i) => {
    const a = r.cgramSrc[i * 2], b = r.cgramSrc[i * 2 + 1];
    return a >= 0 && b === a + 1 ? a : -1;
  });
};
const at = (snes: number) => snesToPc(snes);
const base = sources();
// colors the issue found named $00AD04 / $00AC6C after a change, with their places in the shared palettes
const NAMED: [number, number][] = [[37, 0xb196], [87, 0xb266], [211, 0xb2be], [212, 0xb2c0], [213, 0xb2c2], [230, 0xb320]];
for (const [c, a] of NAMED) check(base[c] === at(a), `color ${c} is loaded from $00:${hx(a)} (${base[c] < 0 ? 'none' : hx(base[c], 5)})`);

const word = (o: number) => rom.data[o] | (rom.data[o + 1] << 8);
const withColors = (offs: number[], v: number, fn: () => void) => {
  const old = offs.map((o) => word(o));
  for (const o of offs) { rom.data[o] = v & 0xff; rom.data[o + 1] = v >> 8; }
  try { fn(); } finally { offs.forEach((o, i) => { rom.data[o] = old[i] & 0xff; rom.data[o + 1] = old[i] >> 8; }); }
};
const diff = (s: number[]) => s.flatMap((x, i) => (x === base[i] ? [] : [`${i}: ${hx(x, 5)} (was ${hx(base[i], 5)})`]));

// the named colors set to the values of the places wrongly named, and to 0
for (const [c, a] of NAMED) {
  for (const v of [word(at(0xad04)), word(at(0xac6c)), 0]) {
    withColors([at(a)], v, () => {
      const d = diff(sources());
      check(!d.length, `color ${c} = ${hx(v)}: all sources as before${d.length ? ` – ${d.join(', ')}` : ''}`);
    });
  }
}
// any single shared color changed (to 0, a value read all over the load)
{
  const shared = [...new Set(base.filter((o) => o >= at(SHARED_PALETTES) && o < at(SHARED_PALETTES) + SHARED_COLORS * 2))];
  const wrong: string[] = [];
  for (const o of shared) withColors([o], 0, () => { const d = diff(sources()); if (d.length) wrong.push(`${hx(o, 5)} = 0: ${d.join(', ')}`); });
  check(shared.length > 100 && !wrong.length, `each of the ${shared.length} shared colors the level loads set to 0 alone: all sources as before${wrong.length ? `\n  ${wrong.slice(0, 5).join('\n  ')}` : ''}`);
}
// all shared colors of one value
for (const v of [0, 0x7fff]) {
  withColors([...Array(SHARED_COLORS).keys()].map((i) => at(SHARED_PALETTES) + i * 2), v, () => {
    const d = diff(sources());
    check(!d.length, `all shared colors ${hx(v)}: all sources as before${d.length ? ` – ${d.slice(0, 8).join(', ')}` : ''}`);
  });
}
// a load without tracking gives no sources
check(emu.load(0x105).cgramSrc.every((v) => v === -1), 'a load without trackSources has no sources');

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exitCode = 1;
