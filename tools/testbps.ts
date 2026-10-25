// BPS patches: created patches apply back to the target (expanded ROM, scattered edits, moved data)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { createBps, applyBps, bpsReader, crc32 } from '../src/core/bps.ts';

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
// read byte by byte: the same target; without the source, the bytes taken from it are not known
const r = bpsReader(p)!;
if (!r || r.sourceSize !== clean.length || r.targetSize !== t.length || r.sourceCrc !== crc32(clean)) throw new Error('reader header');
for (let o = 0; o < t.length; o += 97) if (r.byte(o, (s) => clean[s]) !== t[o]) throw new Error(`reader differs at ${o.toString(16)}`);
let known = 0;
for (let o = 0; o < t.length; o += 97) { const b = r.byte(o, () => null); if (b === null) continue; known++; if (b !== t[o]) throw new Error(`reader without source differs at ${o.toString(16)}`); }
if (r.byte(0x100, () => null) !== null || !known) throw new Error(`reader without source (${known} known)`);
if (bpsReader(clean.subarray(0, 64)) !== null) throw new Error('not a patch read as one');
console.log(`BPS ok: ${p.length} bytes for ${t.length / 1024} KB target (${Math.round(performance.now() - t0)} ms), identity ${same.length} bytes`);
