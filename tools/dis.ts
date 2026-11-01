import { readFileSync } from 'node:fs';
import { disasm, hex } from '../src/core/disasm.ts';
const raw = readFileSync(process.env.ROM ?? 'test/fixtures/smw.smc');
const rom = new Uint8Array(raw.subarray(raw.length % 0x8000));
const rd = (a: number) => rom[((((a >> 16) & 0x7f) << 15) | (a & 0x7fff)) % rom.length];
let a = parseInt(process.argv[2], 16);
const n = Number(process.argv[3] ?? 40);
let m8 = process.argv[4]?.includes('m') ?? true, x8 = process.argv[4]?.includes('x') ?? true;
if (process.argv[4] === '-') { m8 = false; x8 = false; }
for (let i = 0; i < n; i++) {
  const op = rd(a);
  const d = disasm(rd, a, m8, x8);
  const bytes = Array.from({length: d.length}, (_, k) => hex(rd(a + k), 2)).join(' ');
  console.log(hex(a, 6), bytes.padEnd(12), d.text);
  if (op === 0xc2) { const v = rd(a+1); if (v & 0x20) m8 = false; if (v & 0x10) x8 = false; }
  if (op === 0xe2) { const v = rd(a+1); if (v & 0x20) m8 = true; if (v & 0x10) x8 = true; }
  a += d.length;
}
