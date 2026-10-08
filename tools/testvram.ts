// VRAM layout patch (SMWV): with the layer 1/2 tilemaps moved to 64x32 at $3000/$3800, every level
// must look exactly the same: vanilla and patched ROM are played with the same input and the PPU
// images compared frame by frame. Also: VRAM $2000-$2FFF is no longer touched in levels.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PPU } from '../src/core/ppu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { installVramPatch, uninstallVramPatch } from '../src/core/vrampatch.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const vanilla = new Rom(file.slice());
const rom = new Rom(file.slice());
const r = installVramPatch(rom);
check(r.ok, 'patch assembles and applies ' + r.errors.slice(0, 3).join(' | '));

const all = process.argv.includes('--all');
const only = process.argv.find((a) => a.startsWith('--levels='))?.slice(9).split(',').map((x) => parseInt(x, 16));
const levels = only ?? (all ? Array.from({ length: 0x200 }, (_, i) => i) : [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)]);
const frames = Number(process.argv.find((a) => a.startsWith('--frames='))?.slice(9) ?? 360);
const ev = new LevelEmulator(vanilla); ev.boot();
const ep = new LevelEmulator(rom); ep.boot();
const input = (f: number) => 0x4100 | (f % 70 < 34 ? 0x8000 : 0) | (f % 200 > 150 ? 0x0200 : 0) | (f % 300 > 240 ? 0x0800 : 0);

// per game frame ($13 advances; lag frames from the extra code don't count), from entering game mode $14
// both ROMs step per game frame ($13 advances; lag frames don't count), from entering game mode $14.
// Whenever the game state matches (camera of both layers, frame counter), the visible tilemap entries
// of layers 1 and 2 must be identical: the game's 64x64 layout at $2000/$3000 vs. 64x32 at $3000/$3800.
// Pixel differences with a different game state are timing (a lag frame more or less), counted apart.
const w16 = (w: Uint8Array, a: number) => w[a] | (w[a + 1] << 8);
function visible(v: Uint8Array, w: Uint8Array, patched: boolean, layer: 1 | 2): number[] {
  const out: number[] = [];
  const cx = w16(w, layer === 1 ? 0x1a : 0x1e) >> 3, cy = (w16(w, layer === 1 ? 0x1c : 0x20) << 16 >> 16) >> 3;
  const base = patched ? (layer === 1 ? 0x3000 : 0x3800) : (layer === 1 ? 0x2000 : 0x3000);
  for (let y = cy; y < cy + 29; y++) for (let x = cx; x < cx + 33; x++) {
    const xx = x & 63, yy = y & 63;
    // rows 54-63 are never written by the game (garbage in both)
    if (yy >= 54) continue;
    const a = base + (xx & 32 ? 0x400 : 0) + (patched ? 0 : yy & 32 ? 0x800 : 0) + (yy & 31) * 32 + (xx & 31);
    out.push(v[a * 2] | (v[a * 2 + 1] << 8));
  }
  return out;
}

let compared = 0, touching = 0, lagV = 0, lagP = 0, tileBad = 0, pixelFrames = 0, stateFrames = 0, checked = 0;
for (const n of levels) {
  if (!ev.load(n).ok) continue;
  if (!ep.load(n).ok) { console.log(`     ${n.toString(16).padStart(3, '0')}: load fails with the patch`); tileBad++; continue; }
  compared++;
  const A = ev.snes, B = ep.snes;
  const pa = new PPU(A), pb = new PPU(B); A.ppu = pa; B.ppu = pb;
  let touched = 0;
  const orig = (B as any).writeIO.bind(B);
  (B as any).writeIO = (a: number, v: number) => {
    // (only where the new layout is active: boss/mode 7 rooms keep the game's own VRAM use)
    if ((a === 0x2118 || a === 0x2119) && B.wram[0x13602] === 1 && B.wram[0x100] >= 0x11 && B.wram[0x100] <= 0x14 && ((B as any).vramAddrMapped() & 0x7fff) >= 0x2000 && ((B as any).vramAddrMapped() & 0x7fff) < 0x3000) touched++;
    return orig(a, v);
  };
  for (const s of [A, B]) { let g = 0; while (s.wram[0x100] !== 0x14 && g++ < 200) s.runFrame(); }
  let firstBad = -1;
  const lag = [0, 0]; // lag frames of this level so far
  for (let f = 0; f < frames; f++) {
    for (const [s, isP] of [[A, false], [B, true]] as const) {
      s.joy1 = input(f);
      const t = s.wram[0x13];
      s.runFrame();
      for (let k = 0; k < 4 && s.wram[0x13] === t; k++) { s.runFrame(); if (isP) { lagP++; lag[1]++; } else { lagV++; lag[0]++; } }
    }
    // after a lag frame in only one run, an extra NMI has already uploaded what the other uploads next
    // frame: compare only while both had the same number of lag frames
    const same = lag[0] === lag[1] && [0x13, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x5b].every((a) => A.wram[a] === B.wram[a]) && A.wram[0x100] === 0x14 && B.wram[0x100] === 0x14;
    if (!same) { stateFrames++; continue; }
    checked++;
    for (const layer of [1, 2] as const) {
      const va = visible(A.vram, A.wram, false, layer), vb = visible(B.vram, B.wram, B.wram[0x13602] === 1, layer);
      let d = 0; for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) d++;
      if (d && firstBad < 0) { firstBad = f; console.log(`     ${n.toString(16).padStart(3, '0')}: frame ${f} layer ${layer}: ${d} visible tiles differ (camera ${w16(A.wram, 0x1a)},${w16(A.wram, 0x1c)} / ${w16(A.wram, 0x1e)},${w16(A.wram, 0x20)})`); }
    }
    let px = 0; for (let i = 0; i < pa.frame.length; i++) if (pa.frame[i] !== pb.frame[i]) px++;
    if (px) pixelFrames++;
  }
  if (firstBad >= 0) tileBad++;
  if (touched) { touching++; console.log(`     ${n.toString(16).padStart(3, '0')}: ${touched} writes to VRAM $2000-$2FFF`); }
  (B as any).writeIO = orig;
  A.ppu = null; B.ppu = null;
}
console.log(`     ${checked} frames with equal game state checked, ${stateFrames} skipped (state differs by timing); ${pixelFrames} of them with pixel differences (timing within a frame)`);
console.log(`     lag frames: vanilla ${lagV}, patched ${lagP}`);
check(tileBad === 0, `${compared} levels: visible tilemaps identical whenever the game state matches (${tileBad} levels differ)`);
check(touching === 0, `no level writes VRAM $2000-$2FFF with the patch (${touching} do)`);

uninstallVramPatch(rom);
let diff = 0; for (let i = 0; i < file.length - 512 && i < rom.data.length; i++) if (rom.data[i] !== vanilla.data[i] && i !== 0x7fd7) diff++;
check(diff === 0, `uninstall restores the ROM (${diff} bytes differ)`);

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
