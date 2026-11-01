// Boots the game with the real sound unit attached and writes the audio of the first frames as WAV.
// node tools/apuprobe.ts [frames] [out.wav]
import { readFileSync, writeFileSync } from 'node:fs';
import { Snes } from '../src/core/snes.ts';
import { Apu, loadApu, APU_RATE } from '../src/core/apu.ts';
import { hex } from '../src/core/disasm.ts';

await loadApu();
const raw = readFileSync(process.env.ROM ?? 'test/fixtures/smw.smc');
const rom = new Uint8Array(raw.subarray(raw.length % 0x8000));
const snes = new Snes(rom);
snes.apu = new Apu();
snes.powerOn();
const frames = Number(process.argv[2] ?? 600);
const out: Int16Array[] = [];
const t0 = Date.now();
let lastGm = -1;
for (let f = 0; f < frames; f++) {
  snes.runFrame();
  if (snes.audio) out.push(snes.audio);
  const gm = snes.wram[0x100];
  if (gm !== lastGm) { console.log(`frame ${f} gm=${hex(gm, 2)}`); lastGm = gm; }
}
console.log('ms', Date.now() - t0);
const n = out.reduce((a, b) => a + b.length, 0);
let peak = 0;
for (const b of out) for (const v of b) peak = Math.max(peak, Math.abs(v));
console.log('samples', n / 2, 'seconds', (n / 2 / APU_RATE).toFixed(2), 'peak', peak);
const wav = new Uint8Array(44 + n * 2);
const dv = new DataView(wav.buffer);
const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) wav[o + i] = s.charCodeAt(i); };
str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
dv.setUint32(24, APU_RATE, true); dv.setUint32(28, APU_RATE * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
str(36, 'data'); dv.setUint32(40, n * 2, true);
let o = 44;
for (const b of out) for (const v of b) { dv.setInt16(o, v, true); o += 2; }
if (process.argv[3]) writeFileSync(process.argv[3], wav);
