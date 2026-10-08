// BPS patches: created patches apply back to the target (expanded ROM, scattered edits, moved data)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { createBps, applyBps, crc32 } from '../src/core/bps.ts';

const clean = Rom.fromFile(new Uint8Array(readFileSync('test/fixtures/smw.smc'))).output(false);
if (crc32(clean) !== 0xb19ed489) throw new Error('unexpected clean ROM CRC ' + crc32(clean).toString(16));
const t = new Uint8Array(0x200000).fill(0xff);
t.set(clean);
for (let i = 0; i < 2000; i++) t[(i * 7919) % clean.length] ^= 0x5a;
t.set(clean.subarray(0x10000, 0x18000), 0x100000); // copied block
t.set(clean.subarray(0x20000, 0x20400), 0x20800); // moved within the ROM
const t0 = performance.now();
const p = createBps(clean, t, 'test');
const back = applyBps(clean, p);
if (back.length !== t.length || back.some((b, i) => b !== t[i])) throw new Error('round trip differs');
const same = createBps(clean, clean);
if (applyBps(clean, same).some((b, i) => b !== clean[i])) throw new Error('identity differs');
console.log(`BPS ok: ${p.length} bytes for ${t.length / 1024} KB target (${Math.round(performance.now() - t0)} ms), identity ${same.length} bytes`);
