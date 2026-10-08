// Block/sprite probe benchmark (blockprobe.ts): time, emulator runs and frames per probe kind, and
// all results for comparing before/after a speed-up (results must stay the same).
//   node tools/benchprobe.ts [--ts=0,1] [--kinds=runs,blocks,collision,sprites] [--save=file.json] [--check=file.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber } from '../src/core/blockprobe.ts';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const tilesets = (arg('ts') ?? '0,1').split(',').map(Number);
const kinds = new Set((arg('kinds') ?? 'runs,blocks,collision,sprites').split(','));
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const p = new BlockProber(rom);
const s = p.emu.snes;
let frames = 0, runs = 0;
const runFrame = s.runFrame.bind(s), loadState = s.loadState.bind(s);
s.runFrame = (m?: number) => { frames++; runFrame(m); };
s.loadState = (st) => { runs++; loadState(st); };

const results: Record<string, unknown> = {};
const total = { ms: 0, runs: 0, frames: 0 };
const bench = (name: string, n: number, fn: (i: number) => unknown) => {
  if (!kinds.has(name.split('/')[1])) return;
  frames = runs = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) results[`${name}:${i}`] = fn(i);
  const ms = performance.now() - t0;
  total.ms += ms; total.runs += runs; total.frames += frames;
  console.log(`${name.padEnd(12)} ${String(Math.round(ms)).padStart(6)} ms ${String(runs).padStart(6)} runs ${String(frames).padStart(7)} frames`);
};
for (const ts of tilesets) {
  p.use(ts);
  bench(`${ts}/runs`, 1, () => p.runStates());
  bench(`${ts}/blocks`, 0x200, (i) => p.probe(i));
  bench(`${ts}/collision`, 0x200, (i) => p.probeCollision(i));
  bench(`${ts}/sprites`, 0xc9, (i) => p.probeSprite(i));
}
console.log(`${'total'.padEnd(12)} ${String(Math.round(total.ms)).padStart(6)} ms ${String(total.runs).padStart(6)} runs ${String(total.frames).padStart(7)} frames`);

const out = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, JSON.stringify(v)]));
const save = arg('save'), check = arg('check');
if (save) writeFileSync(save, JSON.stringify(out));
if (check) {
  const ref = JSON.parse(readFileSync(check, 'utf8')) as Record<string, string>;
  const diff = Object.keys(ref).filter((k) => k in out && out[k] !== ref[k]);
  for (const k of diff.slice(0, 20)) console.log(`DIFF ${k}\n  was ${ref[k]}\n  now ${out[k]}`);
  console.log(diff.length ? `${diff.length} results differ` : 'results identical');
  if (diff.length) process.exitCode = 1;
}
