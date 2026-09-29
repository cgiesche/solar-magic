// Sprite appearance, captured from the game itself: test sprites are placed in view,
// the level runs a few frames, and the OAM tiles belonging to each sprite are collected.

import { LevelEmulator } from './levelemu.ts';
import { encodePrimaryHeader, type PrimaryHeader } from './level.ts';
import { decodeTile, cgramToRGBA } from './gfx.ts';

export interface SpriteImage {
  w: number;
  h: number;
  ox: number; // offset of image top-left relative to the sprite's tile position (pixels)
  oy: number;
  rgba: Uint32Array;
}

interface OamTile { i: number; x: number; y: number; tile: number; attr: number; big: boolean }

// the game's OAM buffer (copy of $0200-$049F): $0200-$03FF (4 bytes per tile), $0420+i (size/x-high)
function readOamBuffer(buf: Uint8Array): OamTile[] {
  const w = (a: number) => buf[a - 0x200];
  const out: OamTile[] = [];
  for (let i = 0; i < 128; i++) {
    const hi = w(0x420 + i) & 3;
    let x = w(0x200 + i * 4) | ((hi & 1) << 8);
    if (x >= 256) x -= 512;
    const y = w(0x201 + i * 4);
    if (y >= 0xe0 && y < 0xf8) continue; // hidden
    out.push({ i, x, y: y >= 0xf8 ? y - 256 : y, tile: w(0x202 + i * 4), attr: w(0x203 + i * 4), big: (hi & 2) !== 0 });
  }
  return out;
}

export function captureSprites(
  emu: LevelEmulator, level: number, header: PrimaryHeader, spriteHeader: number, bgPointer: number, nums: number[],
  onProgress?: (done: number) => void,
): Map<number, SpriteImage> {
  const result = new Map<number, SpriteImage>();
  const hdr = encodePrimaryHeader({ ...header, mode: 0, screens: 2, time: 2 });
  // empty level with a floor far below; mario enters at the left
  const l1 = new Uint8Array([...hdr, 0xff]);
  const secondary = [0x00, 0x00, 0x00, 0x00];
  // first pass: find camera
  const probe = emu.load(level, { layer1: l1, sprites: new Uint8Array([spriteHeader & 0x3f, 0xff]), secondaryHeader: secondary, layer2Pointer: bgPointer });
  const camX = probe.wram[0x1a] | (probe.wram[0x1b] << 8);
  const camY = probe.wram[0x1c] | (probe.wram[0x1d] << 8);
  const cols = [5, 9, 13], rows = [4, 10];
  const slots: { tx: number; ty: number }[] = [];
  for (const r of rows) for (const c of cols) slots.push({ tx: (camX >> 4) + c, ty: (camY >> 4) + r });
  const s = emu.snes;
  const batches: number[][] = [];
  for (let b = 0; b < nums.length; b += slots.length) batches.push(nums.slice(b, b + slots.length));
  let done = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const first = bi < Math.ceil(nums.length / slots.length);
    const placed = batch.map((n, i) => ({ n, ...slots[i] }));
    // sprite data sorted by x (screen) — they are all on screen 0/1
    const order = [...placed].sort((a, b2) => a.tx - b2.tx || a.ty - b2.ty);
    const data: number[] = [spriteHeader & 0x3f];
    for (const p of order) {
      const screen = p.tx >> 4;
      data.push(((p.ty & 15) << 4) | ((screen & 0x10) >> 3) | ((p.ty >> 4) & 1), ((p.tx & 15) << 4) | (screen & 15), p.n);
    }
    data.push(0xff);
    const r = emu.load(level, { layer1: l1, sprites: new Uint8Array(data), secondaryHeader: secondary, layer2Pointer: bgPointer });
    if (!r.ok) continue;
    // continue running the (still live) emulator state for a few frames, recording which
    // sprite slot writes each OAM buffer entry ($0200-$03FF): the sprite loop stores the slot
    // in $15E9 ($0180A9) before each sprite runs, Yoshi is drawn later with $15E9 set at $01EA83;
    // writes from shallower stack depth end the attribution.
    // (score/extended sprite loops in bank 2 reuse $15E9, hence the bank check)
    const owner = new Int8Array(128).fill(-1);
    let snapOwner = owner.slice(), snapOam = s.wram.slice(0x200, 0x4a0);
    // slots whose OAM entries were overwritten by another sprite in the same frame
    let conflicts = new Set<number>(), snapConflicts = conflicts;
    let cur = -1, s0 = 0;
    s.hook = {
      onWramWrite(a: number, v: number) {
        if (a === 0x15e9) {
          if (s.cpu.pbr === 1) { cur = v; s0 = s.cpu.s; }
          else if (cur >= 0 && s.cpu.s < s0) cur = v; // sprite code switching slots
          else cur = -1;
          return;
        }
        if (cur >= 0 && s.cpu.s > s0) {
          cur = -1;
          snapOwner = owner.slice();
          snapOam = s.wram.slice(0x200, 0x4a0);
          snapConflicts = conflicts;
          conflicts = new Set();
        }
        if (a >= 0x200 && a < 0x400) {
          const e = (a - 0x200) >> 2, prev = owner[e];
          if (cur >= 0 && prev >= 0 && prev !== cur) { conflicts.add(prev); conflicts.add(cur); }
          owner[e] = cur;
        }
      },
    };
    try {
      let guard = 0;
      while (s.wram[0x100] !== 0x14 && guard++ < 80) s.runFrame();
      for (let f = 0; f < 3; f++) s.runFrame();
    } catch { continue; } finally { s.hook = null; }
    const w = s.wram;
    const cx = w[0x1a] | (w[0x1b] << 8), cy = w[0x1c] | (w[0x1d] << 8);
    const obsel = s.ppuRegs[0x01];
    const base = (obsel & 7) << 14;
    const gap = (((obsel >> 3) & 3) + 1) << 13;
    const pal = cgramToRGBA(s.cgram);
    // live sprite slots
    const live = new Map<number, { n: number; x: number; y: number }>();
    for (let i = 0; i < 12; i++) {
      if (w[0x14c8 + i] === 0 || !order[w[0x161a + i]]) continue;
      live.set(i, { n: w[0x9e + i], x: w[0xe4 + i] | (w[0x14e0 + i] << 8), y: w[0xd8 + i] | (w[0x14d4 + i] << 8) });
    }
    const groups = new Map<number, OamTile[]>();
    for (const t of readOamBuffer(snapOam)) {
      const slot = snapOwner[t.i];
      if (!live.has(slot)) continue;
      let g = groups.get(slot);
      if (!g) { g = []; groups.set(slot, g); }
      g.push(t);
    }
    groups.forEach((g, i) => {
      const l = live.get(i)!;
      if (result.has(l.n)) return;
      // partly off screen or sharing OAM entries with another sprite: retry alone in the first slot
      if (batch.length > 1 && (snapConflicts.has(i) || w[0x15a0 + i] || w[0x186c + i]
        || g.some(t => t.x < 0 || t.x + (t.big ? 16 : 8) > 256 || t.y + (t.big ? 16 : 8) > 224))) return;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const t of g) {
        const sz = t.big ? 16 : 8;
        x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x + sz); y1 = Math.max(y1, t.y + sz);
      }
      const W = x1 - x0, H = y1 - y0;
      if (W <= 0 || H <= 0 || W > 256 || H > 256) return;
      const rgba = new Uint32Array(W * H);
      const idx = new Uint8Array(64);
      // OAM draw order: lower index has priority → draw in reverse
      for (let k = g.length - 1; k >= 0; k--) {
        const t = g[k];
        const sz = t.big ? 2 : 1;
        const xf = (t.attr & 0x40) !== 0, yf = (t.attr & 0x80) !== 0;
        const pp = (t.attr >> 1) & 7;
        for (let ty = 0; ty < sz; ty++) for (let tx = 0; tx < sz; tx++) {
          const sub = ((t.tile & 0xf0) + (((t.tile & 0x0f) + tx) & 0x0f) + ty * 16) & 0xff;
          const addr = (base + (t.attr & 1 ? gap : 0) + sub * 32) & 0xffff;
          decodeTile(s.vram, addr, 4, idx);
          const dx0 = (xf ? sz - 1 - tx : tx) * 8, dy0 = (yf ? sz - 1 - ty : ty) * 8;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const c = idx[(yf ? 7 - y : y) * 8 + (xf ? 7 - x : x)];
            if (!c) continue;
            const px = t.x - x0 + dx0 + x, py = t.y - y0 + dy0 + y;
            rgba[py * W + px] = pal[128 + pp * 16 + c];
          }
        }
      }
      // offset relative to the spawn tile, compensating for movement since spawn
      result.set(l.n, { w: W, h: H, ox: x0 + cx - l.x, oy: y0 + cy - l.y, rgba });
    });
    done += batch.length;
    onProgress?.(Math.min(nums.length, done));
    // second pass: retry sprites that were not captured, one per load (centered slot)
    if (first && bi === Math.ceil(nums.length / slots.length) - 1) {
      for (const n of nums) if (!result.has(n)) batches.push([n]);
    }
  }
  return result;
}
