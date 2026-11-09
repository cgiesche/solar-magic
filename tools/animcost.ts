// Cost of the level view's render and of its animation slices (App.refresh, App.startAnimation), on the main thread
// today (#186): per level the load and draw at once, then per background slice one animation step – 8 game frames
// emulated (LevelAnimSteps.next) and drawn as the pixels it changes (animatedPixels, or the whole level
// drawn again when the step changes the backdrop). Reports the slices' time per level and over all levels: a slice
// above 50 ms is a long task (input waits for it), above 16.7 ms it costs a display frame. --each: every step's
// emulation and drawing. Measured for ADR 0010 (editor ROM, Node 24): a slice's emulation 3.5 ms median, the first
// step of a level 15–55 ms (it emulates the fade-in to the level's game mode, 28–38 frames, too); drawing a step
// 1–5 ms, 25–48 ms where a step changes many cells of a large level (F7).
//   node tools/animcost.ts [--levels=105,106,...] [--editor] [--each]
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { LevelAnimSteps } from '../src/core/levelanimsteps.ts';
import { renderLevel, composite, animatedPixels } from '../src/core/render.ts';
import { loadLevel, levelRows, hasOwnContent } from '../src/core/level.ts';
import { exanimPeriod, readLevelList, readGlobalList } from '../src/core/exanim.ts';
import { cleanImage, editorImage } from './fixture.ts';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const rom = new Rom(process.argv.includes('--editor') ? await editorImage() : cleanImage());
const emu = new LevelEmulator(rom);
emu.boot();
const levels = arg('levels')?.split(',').map((s) => parseInt(s, 16)) ??
  Array.from({ length: 0x200 }, (_, i) => i).filter((n) => hasOwnContent(rom, n));

let full = 0;
const emus: number[] = [], slices: number[] = [], renders: number[] = [], totals: number[] = [];
const worst: { level: number; ms: number }[] = [];
for (const n of levels) {
  const lv = loadLevel(rom, n);
  const t0 = performance.now();
  const r = emu.load(n, {});
  if (!r.ok) continue;
  const count = exanimPeriod([readLevelList(rom, n), readGlobalList(rom)], 64, 8);
  const steps = new LevelAnimSteps(emu, count);
  const li = renderLevel(rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
  const base = composite(li);
  renders.push(performance.now() - t0);
  let total = 0, max = 0;
  for (let i = 0; i < count; i++) {
    const s0 = performance.now();
    const snap = steps.next();
    if (!snap) break;
    emus.push(performance.now() - s0);
    const changed = animatedPixels(rom, r, li, base, snap.vram, snap.cgram, (cell) => composite(cell));
    if (!changed) { full++; composite(renderLevel(rom, { ...r, vram: snap.vram, cgram: snap.cgram }, lv.header.mode, lv.header.screens, levelRows(lv.secondary))); }
    const ms = performance.now() - s0;
    slices.push(ms); total += ms; max = Math.max(max, ms);
    if (process.argv.includes('--each')) console.log(`  step ${i}  emulate ${emus.at(-1)!.toFixed(1)}  draw ${(ms - emus.at(-1)!).toFixed(1)}${changed ? '' : '  whole level'}`);
  }
  totals.push(total);
  worst.push({ level: n, ms: max });
  console.log(`${n.toString(16).padStart(3, '0')}  render ${renders.at(-1)!.toFixed(1).padStart(6)} ms  ${String(count).padStart(2)} slices  max ${max.toFixed(1).padStart(6)} ms  total ${total.toFixed(0).padStart(5)} ms`);
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const row = (name: string, a: number[]) => console.log(`${name.padEnd(8)} n ${String(a.length).padStart(5)}  median ${q(a, 0.5).toFixed(1).padStart(6)}  p95 ${q(a, 0.95).toFixed(1).padStart(6)}  max ${q(a, 1).toFixed(1).padStart(6)} ms`);
console.log();
row('render', renders);
row('slice', slices);
row('levels', totals);
row('emulate', emus);
console.log(`slices drawing the whole level again (the backdrop changes): ${full}`);
console.log(`slices over 16.7 ms: ${slices.filter((s) => s > 1000 / 60).length}, over 50 ms: ${slices.filter((s) => s > 50).length}`);
console.log('worst slices:', worst.sort((a, b) => b.ms - a.ms).slice(0, 8).map((w) => `${w.level.toString(16)} ${w.ms.toFixed(1)}`).join(', '));
