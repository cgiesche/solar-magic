// BG tilemap editing: encode/decode, emulator preview (overlay) and save/reload over all vanilla BG levels.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, hasLayer2Objects, hasObjects } from '../src/core/level.ts';
import { renderLevel } from '../src/core/render.ts';
import { saveLevel } from '../src/core/save.ts';
import { bgFromWram, encodeBg, decodeBg } from '../src/core/bg.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';
import { installBgMap16Ext, setBgExtTileWords, bgTileWords, bgMap16Ext } from '../src/core/bgmap16.ts';

const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
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

// extended BG Map16 (SMWH): vanilla BGs stay the same, tiles of pages 2-F are drawn from the new table
const ext = new Rom(file.slice());
installBgMap16Ext(ext);
const emuV = new LevelEmulator(new Rom(file.slice())); emuV.boot();
const emuX = new LevelEmulator(ext); emuX.boot();
// (only the layer 2 tilemap: the hook costs a few cycles, so frame-counter driven animations may differ)
const l2map = (r: { vram: Uint8Array; ppuRegs: Uint8Array }) => { const wa = (r.ppuRegs[0x08] & 0xfc) << 8; return r.vram.subarray(wa * 2, wa * 2 + 0x2000); };
for (const n of edited.keys()) {
  const a = emuV.load(n), b = emuX.load(n);
  if (!b.ok || !same(l2map(a), l2map(b))) { console.log(n.toString(16), 'SMWH changes the vanilla BG', b.error ?? ''); bad++; }
}
// words of BG tile (x, y) in the layer 2 tilemap (VRAM, 64x64 cells): TL, BL, TR, BR
const vramBg = (r: { vram: Uint8Array; ppuRegs: Uint8Array }, x: number, y: number) => {
  const base = (r.ppuRegs[0x08] & 0xfc) << 8;
  const cell = (cx: number, cy: number) => {
    const wa = base + (cx >= 32 ? 0x400 : 0) + (cy >= 32 ? 0x800 : 0) + (cy & 31) * 32 + (cx & 31);
    return r.vram[wa * 2] | (r.vram[wa * 2 + 1] << 8);
  };
  return [cell(2 * x, 2 * y), cell(2 * x, 2 * y + 1), cell(2 * x + 1, 2 * y), cell(2 * x + 1, 2 * y + 1)];
};
const nx = [...edited.keys()][1];
for (let t = 0x200; t < 0x1000; t += 0x111) setBgExtTileWords(ext, t, [t, t + 1, t + 2, t + 3].map((v) => v & 0xc3ff));
const bgx = new Uint16Array(0x360);
for (let o = 0; o < bgx.length; o++) bgx[o] = o % 4 === 0 ? 0x200 + ((o * 0x111) % 0xe00) : (o * 37) & 0x1ff;
if (!same(decodeBg(encodeBg(bgx)), bgx)) { console.log('encode/decode with pages 2-F differs'); bad++; }
const lvx = loadLevel(ext, nx); lvx.bg = bgx; saveLevel(ext, lvx);
const emuX2 = new LevelEmulator(ext); emuX2.boot();
const rx = emuX2.load(nx);
if (!rx.ok || !same(bgFromWram(rx.wram), bgx)) { console.log(nx.toString(16), 'saved BG with pages 2-F differs', rx.error ?? ''); bad++; }
let wrong = 0;
for (let y = 0; y < 27; y++) for (let x = 0; x < 32; x++) {
  const t = bgx[(x >> 4) * 0x1b0 + y * 16 + (x & 15)];
  if (!same(vramBg(rx, x, y), bgTileWords(ext, t))) wrong++;
}
if (wrong) { console.log(nx.toString(16), 'game draws', wrong, 'BG tiles not like the editor'); bad++; }
// saving a BG with tiles of pages 2-F installs the patch
const plain = new Rom(file.slice());
const lvp = loadLevel(plain, nx); lvp.bg = bgx; saveLevel(plain, lvp);
if (!bgMap16Ext(plain)) { console.log('saving BG tiles >= 200 did not install SMWH'); bad++; }
console.log('bg levels', n2, 'bad', bad);
if (bad) process.exitCode = 1;
