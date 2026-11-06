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

// Stripes of every shape the game's format has, put into the buffer before an NMI (#406: the patch handles them per
// entry, cut where the tiles stop lying side by side): rows across tile rows and screens, columns across screens,
// RLE, odd lengths, entries for other VRAM in between, on both layers, the window anywhere (the camera moved). Each
// word of the game's 64x64 layout (the last one written there) must be in VRAM at its place in the 64x32 tilemap if
// its row is in the window – horizontal: the 32 rows from the window's first, below row 54; vertical: the camera's
// block rows c..c+14 – and in the shadow (horizontal layers, rows 0-53)
{
  let seed = 406;
  const rnd = (n: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed % n; };
  let cases = 0, words = 0, shown = 0;
  const wrong: string[] = [];
  for (const n of [0x105, 0x106, 0x12a, 0x00c]) {
    const p = PlaySession.start(ep, n);
    const s = ep.snes;
    for (let t = 0; t < 25 && !wrong.length; t++) {
      const pad = (rnd(3) ? PAD.right : PAD.left) | (rnd(2) ? PAD.b : 0) | PAD.y;
      if (p.play(2 + rnd(15), (f) => (f % 30 < 15 ? pad : pad & ~PAD.b))) break;
      // at the main loop's wait for the NMI (the frame's stripes are in the buffer), the camera anywhere
      for (let k = 0; ((s.cpu.pbr << 16 | s.cpu.pc) & 0x7fffff) !== 0x806b && k < 200000; k++) s.cpu.step();
      if (rnd(3)) for (const a of [0x1c, 0x20]) { const y = rnd(0x1d0) - 0x10; s.wram[a] = y & 0xff; s.wram[a + 1] = (y >> 8) & 0xff; }
      const model = new Map<number, number>(); // game address → word
      let len = w16(s.wram, 0x1837b);
      for (let e = 1 + rnd(6); e > 0; e--) {
        const other = rnd(4) === 0, d = rnd(2), r = rnd(4) === 0;
        const a = other ? [0x5000 + rnd(0x400), 0x4000 + rnd(0x1000), 0x1fc0 + rnd(0x40)][rnd(3)] : 0x2000 + rnd(0x2000);
        const nw = 1 + (rnd(3) ? rnd(6) : rnd(48)), bytes = 2 * nw - (rnd(8) ? 0 : 1);
        const data = Array.from({ length: r ? 2 : bytes }, () => rnd(256));
        const ent = [a >> 8, a & 0xff, (d << 7) | (r ? 0x40 : 0) | ((bytes - 1) >> 8), (bytes - 1) & 0xff, ...data];
        s.wram.set(ent, 0x1837d + len); len += ent.length;
        // (an odd length's last word takes its high byte from what follows: not looked at)
        if (a >= 0x2000 && a < 0x4000) for (let k = 0; k < nw; k++) {
          const at = (a + k * (d ? 32 : 1)) & 0xffff;
          if (!r && 2 * k + 1 >= bytes) model.delete(at);
          else model.set(at, r ? data[0] | (data[1] << 8) : data[2 * k] | (data[2 * k + 1] << 8));
        }
      }
      s.wram[0x1837d + len] = 0xff; s.wram[0x1837b] = len & 0xff; s.wram[0x1837c] = len >> 8;
      // to the NMI's end (the shadow is written after the screen is on)
      let snap: [Uint8Array, Uint8Array] | null = null;
      const step = s.cpu.step.bind(s.cpu);
      s.cpu.step = () => { if (!snap && ((s.cpu.pbr << 16 | s.cpu.pc) & 0x7fffff) === 0x82bc) snap = [s.vram.slice(), s.wram.slice()]; return step(); };
      for (let f = 0; f < 2 && !snap; f++) s.runFrame();
      s.cpu.step = step;
      if (!snap) { wrong.push(`${n.toString(16)}: no NMI`); break; }
      const [v, w] = snap as [Uint8Array, Uint8Array];
      cases++;
      for (const [a, word] of model) {
        if (a >= 0x4000) continue; // (an entry running past the tilemaps: the patch's own business)
        const l2 = a >= 0x3000, vert = !!(w[RAM.screenMode] & (l2 ? 2 : 1));
        const y = ((a >> 5) & 31) | ((a >> 6) & 32);
        const tall = !l2 && w[0x13654] === 1;
        let inWin: boolean;
        if (vert) inWin = (((y >> 1) - (w16(w, l2 ? 0x20 : 0x1c) >> 4)) & 31) < 15;
        else { const win = w[0x13600 + +l2]; inWin = win !== 0xff && (y < 54 || tall) && ((y - win) & 63) < 32; }
        const at = (l2 ? 0x3800 : 0x3000) | (a & 0x7ff);
        words++;
        if (inWin) { shown++; if (w16(v, at * 2) !== word) wrong.push(`${n.toString(16)} case ${t}: ${a.toString(16)} → VRAM ${at.toString(16)}: ${w16(v, at * 2).toString(16)}, not ${word.toString(16)}`); }
        const sh = 0x10000 + (l2 ? 0x1b00 : 0) + y * 128 + (a & 31) * 2 + (a & 0x400 ? 64 : 0);
        if (!vert && !tall && y < 54 && w16(w, sh) !== word) wrong.push(`${n.toString(16)} case ${t}: ${a.toString(16)} → shadow: ${w16(w, sh).toString(16)}, not ${word.toString(16)}`);
      }
      // nothing else written: a horizontal layer's window in VRAM is its shadow's rows
      for (const l2 of [0, 1]) {
        const win = w[0x13600 + l2];
        if (w[RAM.screenMode] & (l2 + 1) || win === 0xff || (!l2 && w[0x13654] === 1)) continue;
        for (let i = 0; i < 32; i++) {
          const y = (win + i) & 63;
          if (y >= 54) continue;
          for (let x = 0; x < 64; x++) {
            const at = (l2 ? 0x3800 : 0x3000) + (x & 32 ? 0x400 : 0) + (y & 31) * 32 + (x & 31);
            const sh = 0x10000 + (l2 ? 0x1b00 : 0) + y * 128 + (x & 31) * 2 + (x & 32 ? 64 : 0);
            if (w16(v, at * 2) !== w16(w, sh)) { wrong.push(`${n.toString(16)} case ${t}: layer ${l2 + 1} row ${y} column ${x}: VRAM ${w16(v, at * 2).toString(16)}, shadow ${w16(w, sh).toString(16)}`); break; }
          }
        }
      }
    }
  }
  check(!wrong.length && cases > 60, `stripes of every shape: each word where the game's layout has it, mapped (${cases} cases, ${words} words, ${shown} in the window)${wrong.length ? ': ' + wrong.slice(0, 4).join('; ') : ''}`);
}


console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
