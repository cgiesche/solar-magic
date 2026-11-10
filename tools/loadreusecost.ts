// What a level load costs as an edit's step (#448): every object of a level moved a tile and loaded, after the load
// before it (a drag's steps), on an emulator emulating every load whole and on one taking over the frames of the
// previous load that read the same (LevelEmulator.reuseLoads). Prints the median and 90th percentile per load and
// the frames emulated.
//   node tools/loadreusecost.ts [level …]   (hex, default 105 106 103)
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { editorImage } from './fixture.ts';

const levels = process.argv.slice(2).map((s) => parseInt(s, 16));
const rom = new Rom(await editorImage());
const at = (a: number[], q: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
for (const reuse of [false, true]) {
  const emu = new LevelEmulator(rom);
  emu.reuseLoads = reuse;
  emu.boot();
  for (const n of levels.length ? levels : [0x105, 0x106, 0x103]) {
    const lv = loadLevel(rom, n);
    emu.load(n, levelOverride(rom, lv));
    const ms: number[] = [], emulated: number[] = [];
    for (let k = 0; k < 3; k++) for (const o of lv.objects) {
      o.x++;
      const ov = levelOverride(rom, lv), t = performance.now();
      emu.load(n, ov);
      ms.push(performance.now() - t);
      emulated.push(emu.emulatedFrames);
      o.x--;
    }
    console.log(`${reuse ? 'reuse' : 'whole'} ${n.toString(16).padStart(3, '0')}: ${at(ms, 0.5).toFixed(2)} ms median, ${at(ms, 0.9).toFixed(2)} ms p90; frames emulated ${at(emulated, 0.5)} median, ${at(emulated, 0.9)} p90`);
  }
}
