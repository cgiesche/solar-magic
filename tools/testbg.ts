// BG tilemap editing: encode/decode, emulator preview (overlay) and save/reload over all vanilla BG levels.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, hasLayer2Objects, hasObjects } from '../src/core/level.ts';
import { renderLevel } from '../src/core/render.ts';
import { saveLevel } from '../src/core/save.ts';
import { bgFromWram, encodeBg, decodeBg } from '../src/core/bg.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';

const file = new Uint8Array(readFileSync('Super Mario World (U) [!].smc'));
const rom = new Rom(file.slice());
const emu = new LevelEmulator(rom);
emu.boot();
const list = [...Array(0x25).keys(), ...Array.from({ length: 0x3c }, (_, i) => 0x101 + i)];
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
let bad = 0, n2 = 0;
const edited = new Map<number, Uint16Array>();
for (const n of list) {
  const lv = loadLevel(rom, n);
  if (hasLayer2Objects(lv.header.mode) || !hasObjects(lv.header.mode)) continue;
  n2++;
  const r = emu.load(n);
  const bg = bgFromWram(r.wram);
  if (!same(decodeBg(encodeBg(bg)), bg)) { console.log(n.toString(16), 'encode/decode differs'); bad++; }
  const r2 = emu.load(n, { bgData: encodeBg(bg) });
  const a = renderLevel(rom, r, lv.header.mode, lv.header.screens).layer2, b = renderLevel(rom, r2, lv.header.mode, lv.header.screens).layer2;
  if (!r2.ok || !same(a, b)) { console.log(n.toString(16), 'preview differs', r2.error ?? ''); bad++; }
  const mod = bg.slice();
  for (let o = 0; o < mod.length; o += 7) mod[o] = (o * 13) & 0x1ff; // tiles from both pages
  edited.set(n, mod);
}
// level files carry edited BG tiles
for (const [n, mod] of edited) {
  const lv = loadLevel(rom, n); lv.bg = mod;
  const back = importLevelFile(rom, exportLevelFile(rom, lv), lv).level.bg;
  if (!back || !same(back, mod)) { console.log(n.toString(16), 'level file BG differs'); bad++; }
}
// save every edited BG, then reload each level from the saved ROM
for (const [n, mod] of edited) { const lv = loadLevel(rom, n); lv.bg = mod; saveLevel(rom, lv); }
const emu2 = new LevelEmulator(rom);
emu2.boot();
for (const [n, mod] of edited) {
  const r = emu2.load(n);
  if (!r.ok || !same(bgFromWram(r.wram), mod)) { console.log(n.toString(16), 'saved BG differs', r.error ?? ''); bad++; }
}
// restoring a vanilla pointer drops the custom data again
const n0 = [...edited.keys()][0], vanilla = new Rom(file.slice());
const lv0 = loadLevel(rom, n0);
lv0.layer2Pointer = loadLevel(vanilla, n0).layer2Pointer;
saveLevel(rom, lv0);
const emu3 = new LevelEmulator(rom); emu3.boot();
const vr = new LevelEmulator(vanilla); vr.boot();
if (!same(bgFromWram(emu3.load(n0).wram), bgFromWram(vr.load(n0).wram))) { console.log(n0.toString(16), 'revert to vanilla BG failed'); bad++; }
console.log('bg levels', n2, 'bad', bad);
if (bad) process.exitCode = 1;
