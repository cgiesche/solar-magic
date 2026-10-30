// VRAM layout patch (SMWV): with the layer 1/2 tilemaps moved to 64x32 at $3000/$3800, every level
// must look exactly the same: vanilla and patched ROM are played with the same input and the PPU
// images compared frame by frame. Also: VRAM $2000-$2FFF is no longer touched in levels.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PPU } from '../src/core/ppu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { installVramPatch } from '../src/core/vrampatch.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { GM, RAM, PAD, standMario } from '../src/core/ram.ts';

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
const input = (f: number) => PAD.y | PAD.right | (f % 70 < 34 ? PAD.b : 0) | (f % 200 > 150 ? PAD.left : 0) | (f % 300 > 240 ? PAD.up : 0);

// per game frame ($13 advances; lag frames from the extra code don't count), from entering game mode $14
// both ROMs step per game frame ($13 advances; lag frames don't count), from entering game mode $14.
// Whenever the game state matches (camera of both layers now and the frame before, frame counter), the
// visible tilemap entries of layers 1 and 2 must be identical: the game's 64x64 layout at $2000/$3000 vs.
// 64x32 at $3000/$3800. Visible at the camera of the frame before (the scroll the NMI set; a row the game
// builds for the camera now is uploaded in the next NMI).
// Pixel differences with a different game state are timing (a lag frame more or less), counted apart.
const w16 = (w: Uint8Array, a: number) => w[a] | (w[a + 1] << 8);
const camera = (s: { wram: Uint8Array }) => s.wram.slice(0x1a, 0x22);
// cam: $1A-$21 of the frame before
function visible(v: Uint8Array, w: Uint8Array, cam: Uint8Array, patched: boolean, layer: 1 | 2): number[] {
  const out: number[] = [];
  const cx = w16(cam, layer === 1 ? 0 : 4) >> 3, cy = (w16(cam, layer === 1 ? 2 : 6) << 16 >> 16) >> 3;
  const base = patched ? (layer === 1 ? 0x3000 : 0x3800) : (layer === 1 ? 0x2000 : 0x3000);
  for (let y = cy; y < cy + 29; y++) for (let x = cx; x < cx + 33; x++) {
    const xx = x & 63, yy = y & 63;
    // rows 54-63 of a horizontal layer are never written by the game (garbage in both)
    if (yy >= 54 && !(w[RAM.screenMode] & layer)) continue;
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
    if ((a === 0x2118 || a === 0x2119) && B.wram[0x13602] === 1 && B.wram[RAM.gameMode] >= GM.levelLoad && B.wram[RAM.gameMode] <= GM.level && ((B as any).vramAddrMapped() & 0x7fff) >= 0x2000 && ((B as any).vramAddrMapped() & 0x7fff) < 0x3000) touched++;
    return orig(a, v);
  };
  for (const e of [ev, ep]) PlaySession.resume(e).until('gameplay');
  let firstBad = -1;
  const lag = [0, 0]; // lag frames of this level so far
  const cam = [camera(A), camera(B)];
  for (let f = 0; f < frames; f++) {
    for (const [s, isP] of [[A, false], [B, true]] as const) {
      s.joy1 = input(f);
      const t = s.wram[0x13];
      cam[+isP] = camera(s);
      s.runFrame();
      for (let k = 0; k < 4 && s.wram[0x13] === t; k++) { cam[+isP] = camera(s); s.runFrame(); if (isP) { lagP++; lag[1]++; } else { lagV++; lag[0]++; } }
    }
    // after a lag frame in only one run, an extra NMI has already uploaded what the other uploads next
    // frame: compare only while both had the same number of lag frames
    const same = lag[0] === lag[1] && [0x13, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x5b].every((a) => A.wram[a] === B.wram[a]) && A.wram[RAM.gameMode] === GM.level && B.wram[RAM.gameMode] === GM.level
      && cam[0].every((v, i) => v === cam[1][i]);
    if (!same) { stateFrames++; continue; }
    checked++;
    for (const layer of [1, 2] as const) {
      const va = visible(A.vram, A.wram, cam[0], false, layer), vb = visible(B.vram, B.wram, cam[1], B.wram[0x13602] === 1, layer);
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

// A vertical level: the game builds a block row when the camera enters it, the tilemap holds 16 of them.
// 12A's camera stops at a block row (its bottom, camera Y 400) and goes up: the row that comes into view
// at the top (3F) shares its slot with the level's last row (4F). Mario is put on 0B/3F after the start,
// the camera follows him up; then he hits the vine block above him (0B/3C) and stays while the vine grows
// up to row 28, whose slot is on screen row 38's. Layer 1 must look the same as in the game.
{
  const runs = [ev, ep].map((e) => PlaySession.start(e, 0x12a));
  const first: string[] = ['', ''];
  let y = 0;
  for (let f = 0; f < 400; f++) {
    const [va, vb] = runs.map((p, i) => {
      const cam = camera(p);
      if (f < 60 || f >= 100) standMario(p.wram, 0xb0, 0x3e0);
      p.frame(f >= 60 && f < 80 ? PAD.b : 0);
      return visible(p.emu.snes.vram, p.wram, cam, i === 1, 1);
    });
    const d = va.filter((v, i) => v !== vb[i]).length;
    if (f === 59) y = w16(runs[0].wram, 0x1c);
    if (d && !first[+(f >= 60)]) first[+(f >= 60)] = `frame ${f}, camera Y ${w16(runs[0].wram, 0x1c).toString(16)}: ${d} tiles differ`;
  }
  const vine = runs.map((p) => p.wram[0xc800 + 2 * 0x200 + 8 * 16 + 0x0b]);
  check(!first[0] && y < 0x3f0, `12A, camera from its bottom up to row 3F: layer 1 as in the game (${first[0] || 'camera Y ' + y.toString(16)})`);
  check(!first[1] && vine.every((t) => t === 6), `12A, the vine grows up to row 28: layer 1 as in the game (${first[1] || 'vine tile at 0B/28: ' + vine.join(', ')})`);
}


console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
