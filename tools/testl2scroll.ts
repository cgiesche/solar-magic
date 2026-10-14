// Layer 2 scroll rates (l2scroll.ts): the game's paired settings move layer 2 as in the clean game,
// and separate horizontal and vertical rates (Lunar Magic 3.40's) move it at the rates Lunar Magic's
// help gives (level_layer12_settings.htm), measured by letting the level run.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, encodeSecondaryHeader, decodeSecondaryHeader, readSecondaryHeader, type SecondaryHeader } from '../src/core/level.ts';
import { layer2Motion, type Motion } from '../src/core/l2scroll.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';
import { mwlSections } from '../src/core/mwl.ts';
import { uploadFiles } from '../src/core/patchpkg.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const fmt = (m: Motion) => `rate ${m.rate.toFixed(3)} drift ${m.drift.toFixed(2)}`;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
const clean = new LevelEmulator(new Rom(cleanImage()));
const N = 0x105;
const sec0 = readSecondaryHeader(rom, N);
const motion = (e: LevelEmulator, s: Partial<SecondaryHeader>) => layer2Motion(e, N, { secondaryHeader: encodeSecondaryHeader({ ...sec0, ...s }) });

// the game's 16 paired settings: as in the clean game
for (let p = 0; p < 16; p++) {
  const a = motion(emu, { layer2Scroll: p }), b = motion(clean, { layer2Scroll: p });
  const same = (x: Motion, y: Motion) => near(x.rate, y.rate, 0.02) && near(x.drift, y.drift, 0.01);
  check(same(a.x, b.x) && same(a.y, b.y), `paired setting ${p.toString(16)}: H ${fmt(a.x)}, V ${fmt(a.y)} (clean game: H ${fmt(b.x)}, V ${fmt(b.y)})`);
}

// separate rates: the same list for both directions (LM help: relative to layer 1)
const RATES: [number, string, number][] = [
  [0, 'None', 0], [1, 'Constant', 1], [2, 'Medium', 1 / 2], [3, 'Slow', 1 / 32], [4, 'Medium 2', 1 / 4],
  [5, 'Medium 3', 1 / 8], [6, 'Medium 4', 1 / 16], [7, 'Slow 2', 1 / 64], [8, 'Fast', 1.2],
];
const rateOk = (m: Motion, r: number) => near(m.rate, r, Math.max(0.01, r * 0.3)) && near(m.drift, 0, 0.01);
for (const [v, name, r] of RATES) {
  const m = motion(emu, { layer2Separate: 1, layer2Scroll: v, layer2HAuto: 0, layer2V: v });
  check(rateOk(m.x, r) && rateOk(m.y, r), `separate ${name}: H ${fmt(m.x)}, V ${fmt(m.y)} (${r})`);
}
// auto-scroll: layer 2 follows layer 1 and moves on by itself (Slow: fog, Fast: tides, Fast 4: fast BG scroll sprite)
const SPEEDS = [0.25, 0.5, 1, 2, 3, 4];
for (let i = 0; i < 12; i++) {
  const speed = SPEEDS[i % 6] * (i < 6 ? 1 : -1); // up/left first: the layer's position grows
  const m = motion(emu, { layer2Separate: 1, layer2HAuto: 1, layer2Scroll: i, layer2V: 0x10 + i });
  const ok = (a: Motion) => near(a.rate, 1, 0.05) && near(a.drift, speed, 0.05);
  check(ok(m.x) && ok(m.y), `auto-scroll ${i < 6 ? 'left/up' : 'right/down'} ${SPEEDS[i % 6]}: H ${fmt(m.x)}, V ${fmt(m.y)}`);
}

// the editor's ROM: no level has separate rates, vanilla levels keep their setting
check([0x105, 0x106, 0x01f, 0x0c7].every((n) => readSecondaryHeader(rom, n).layer2Separate === 0), 'vanilla levels: paired settings');
check(loadLevel(rom, 0x106).secondary.layer2Scroll === readSecondaryHeader(new Rom(cleanImage()), 0x106).layer2Scroll, 'level 106 keeps its layer 2 scroll');

// the level's rates go along with it: level file, Lunar Magic level file (level information byte 17)
{
  const lv = loadLevel(rom, N);
  lv.secondary = { ...lv.secondary, layer2Separate: 1, layer2HAuto: 1, layer2Scroll: 7, layer2V: 0x13 };
  const back = importLevelFile(rom, exportLevelFile(rom, lv), lv).level.secondary;
  check(encodeSecondaryHeader(back).join() === encodeSecondaryHeader(lv.secondary).join(), 'level file keeps the separate rates');
  const files = uploadFiles('s.zip', new Uint8Array(readFileSync('test/fixtures/sonicmaniasszact1.zip')));
  const mwl = [...files].find(([n]) => n.endsWith('.mwl'))![1].slice();
  const info = mwl[0x40] | (mwl[0x41] << 8) | (mwl[0x42] << 16);
  mwl[info + 17] = 0xe6; // separate, horizontal auto-scroll, (auto-set screens), vertical Medium 4
  const sec = decodeSecondaryHeader(mwlSections(mwl).secondary);
  check(sec.layer2Separate === 1 && sec.layer2HAuto === 1 && sec.layer2V === 6, '.mwl: separate rates from level information byte 17');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
