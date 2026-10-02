// Sprite appearance, captured from the game itself: test sprites are placed in view,
// the level runs a few frames, and the OAM tiles belonging to each sprite are collected.

import { LevelEmulator } from './levelemu.ts';
import { encodePrimaryHeader, spriteBytes, spriteSizes, type PrimaryHeader, type SpriteSizes } from './level.ts';
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

// tiles the PPU shows (OAM after the last frame's DMA)
function readPpuOam(oam: Uint8Array): OamTile[] {
  const out: OamTile[] = [];
  for (let i = 0; i < 128; i++) {
    const hi = (oam[0x200 + (i >> 2)] >> ((i & 3) * 2)) & 3;
    let x = oam[i * 4] | ((hi & 1) << 8);
    if (x >= 256) x -= 512;
    const y = oam[i * 4 + 1];
    if (y >= 0xe0 && y < 0xf8) continue; // hidden
    out.push({ i, x, y: y >= 0xf8 ? y - 256 : y, tile: oam[i * 4 + 2], attr: oam[i * 4 + 3], big: (hi & 2) !== 0 });
  }
  return out;
}
const tileKey = (t: OamTile) => `${t.x},${t.y},${t.tile},${t.attr},${t.big}`;

// nums: sprite ids (see spriteId; custom sprites $2xx/$3xx); bytes: extra bytes of custom sprites (else 0)
export function captureSprites(
  emu: LevelEmulator, level: number, header: PrimaryHeader, spriteHeader: number, bgPointer: number, nums: number[],
  onProgress?: (done: number) => void, bytes?: number[],
): Map<number, SpriteImage> {
  const result = new Map<number, SpriteImage>();
  const { l1, secondary, camX, camY } = testLevel(emu, level, header, spriteHeader, bgPointer);
  const cols = [5, 9, 13], rows = [4, 10];
  const slots: { tx: number; ty: number }[] = [];
  for (const r of rows) for (const c of cols) slots.push({ tx: (camX >> 4) + c, ty: (camY >> 4) + r });
  const s = emu.snes;
  // what the empty level shows (Mario): sprites drawn outside the sprite slots (cluster sprites
  // like Boo rings) are what a load with them shows in addition
  let baseline: Set<string> | null = null;
  if (nums.some(alone) && record(emu, 3)) baseline = new Set(readPpuOam(s.oam).map(tileKey));
  // sprites from $C9 on load specially (shells as Koopas, groups spawn several slots), custom shooters and
  // generators don't take a slot: one per load, everything that is alive then belongs to it
  const normal = nums.filter((n) => !alone(n)), batches: number[][] = [];
  for (let b = 0; b < normal.length; b += slots.length) batches.push(normal.slice(b, b + slots.length));
  for (const n of nums) if (alone(n)) batches.push([n]);
  const firstPass = batches.length;
  let done = 0;
  for (let bi = 0; ; bi++) {
    // second pass: retry sprites that were not captured, one per load (centered slot); also those
    // of a batch that failed to load as a whole (one sprite crashing the test level)
    if (bi === firstPass) for (const n of normal) if (!result.has(n)) batches.push([n]);
    if (bi >= batches.length) break;
    const batch = batches[bi];
    const solo = batch.length === 1 && alone(batch[0]);
    const placed = batch.map((id, i) => ({ id, n: id & 0xff, extra: id >> 8, bytes, ...slots[i] }));
    const order = sortPlaced(placed);
    const r = emu.load(level, { layer1: l1, sprites: testSpriteData(spriteHeader, order, spriteSizes(emu.rom)), secondaryHeader: secondary, layer2Pointer: bgPointer });
    if (!r.ok) continue;
    const rec = record(emu, 3);
    if (!rec) continue;
    const { snapOwner, snapOam, snapConflicts } = rec;
    const w = s.wram;
    const cx = w[0x1a] | (w[0x1b] << 8), cy = w[0x1c] | (w[0x1d] << 8);
    // live sprite slots (alone, a sprite from $C9 on owns all: shells $DA-$DD load as a Koopa
    // 04-07 in carryable state, so $9E is not the placed number; a custom sprite's $9E is what it acts like)
    const live = new Map<number, { n: number; x: number; y: number }>();
    for (let i = 0; i < 12; i++) {
      const from = order[w[0x161a + i]];
      if (w[0x14c8 + i] === 0 || !(solo || from)) continue;
      live.set(i, { n: solo ? batch[0] : from.id >= 0x200 ? from.id : w[0x9e + i], x: w[0xe4 + i] | (w[0x14e0 + i] << 8), y: w[0xd8 + i] | (w[0x14d4 + i] << 8) });
    }
    const groups = new Map<number, OamTile[]>();
    for (const t of readOamBuffer(snapOam)) {
      const slot = snapOwner[t.i];
      if (!live.has(slot)) continue;
      let g = groups.get(slot);
      if (!g) { g = []; groups.set(slot, g); }
      g.push(t);
    }
    // a group sprite ($DE five Eeries, $E0 three platforms) is drawn as a whole, positioned by
    // the slot that came from the level data
    if (solo && groups.size > 1) {
      const all = [...groups.values()].flat();
      const main = [...groups.keys()].find((i) => w[0x161a + i] === 0) ?? [...groups.keys()][0];
      groups.clear();
      groups.set(main, all);
    }
    if (solo && !groups.size && baseline) {
      const extra = readPpuOam(s.oam).filter((t) => !baseline!.has(tileKey(t)));
      const img = extra.length ? drawTiles(emu, extra) : null;
      const p = placed[0];
      if (img) result.set(p.id, { ...img, ox: img.ox + cx - p.tx * 16, oy: img.oy + cy - p.ty * 16 });
    }
    groups.forEach((g, i) => {
      const l = live.get(i)!;
      if (result.has(l.n)) return;
      // partly off screen or sharing OAM entries with another sprite: retry alone in the first slot
      if (batch.length > 1 && (snapConflicts.has(i) || w[0x15a0 + i] || w[0x186c + i]
        || g.some(t => t.x < 0 || t.x + (t.big ? 16 : 8) > 256 || t.y + (t.big ? 16 : 8) > 224))) return;
      const img = drawTiles(emu, g);
      // offset relative to the spawn tile, compensating for movement since spawn
      if (img) result.set(l.n, { ...img, ox: img.ox + cx - l.x, oy: img.oy + cy - l.y });
    });
    done += batch.length;
    onProgress?.(Math.min(nums.length, done));
  }
  return result;
}

// loaded one per test level: sprites from $C9 on, custom shooters and generators (C0-DF)
const alone = (id: number) => (id >= 0x200 ? (id & 0xff) >= 0xc0 : id >= 0xc9);

// The empty test level (horizontal, two screens, floor far below; Mario enters at the left)
// and where its camera starts
export function testLevel(emu: LevelEmulator, level: number, header: PrimaryHeader, spriteHeader: number, bgPointer: number) {
  const hdr = encodePrimaryHeader({ ...header, mode: 0, screens: 2, time: 2 });
  const l1 = new Uint8Array([...hdr, 0xff]);
  const secondary = [0x00, 0x00, 0x00, 0x00];
  const probe = emu.load(level, { layer1: l1, sprites: new Uint8Array([spriteHeader & 0x3f, 0xff]), secondaryHeader: secondary, layer2Pointer: bgPointer });
  return { l1, secondary, camX: probe.wram[0x1a] | (probe.wram[0x1b] << 8), camY: probe.wram[0x1c] | (probe.wram[0x1d] << 8) };
}

export interface PlacedSprite { n: number; tx: number; ty: number; extra?: number; bytes?: number[] }

// level sprite data must be sorted by x (screen); $161A of a live slot is the index in this order
export function sortPlaced<T extends PlacedSprite>(placed: T[]): T[] {
  return [...placed].sort((a, b) => a.tx - b.tx || a.ty - b.ty);
}

// sprite data of the test level (horizontal format) for sprites sorted with sortPlaced;
// sizes: the ROM's sprite size table (custom sprites with extra bytes)
export function testSpriteData(spriteHeader: number, order: PlacedSprite[], sizes: SpriteSizes): Uint8Array {
  const data: number[] = [spriteHeader & 0x3f];
  for (const p of order) {
    const screen = p.tx >> 4, extra = p.extra ?? 0;
    data.push(((p.ty & 15) << 4) | ((extra & 3) << 2) | ((screen & 0x10) >> 3) | ((p.ty >> 4) & 1), ((p.tx & 15) << 4) | (screen & 15), p.n,
      ...spriteBytes(sizes, { extra, num: p.n, bytes: p.bytes }));
  }
  data.push(0xff);
  return new Uint8Array(data);
}

// Continues the live emulator state for a few frames (first into gameplay), recording which
// sprite slot writes each OAM buffer entry ($0200-$03FF): the sprite loop stores the slot
// in $15E9 ($0180A9) before each sprite runs, Yoshi is drawn later with $15E9 set at $01EA83;
// writes from shallower stack depth end the attribution.
// (score/extended sprite loops in bank 2 reuse $15E9, hence the bank check)
// snapLost: slots that lost a visible tile that way (the tile is missing on screen) and the slots
// that overwrote it
export function record(emu: LevelEmulator, frames: number): { snapOwner: Int8Array; snapOam: Uint8Array; snapConflicts: Set<number>; snapLost: Set<number> } | null {
  const s = emu.snes;
  const owner = new Int8Array(128).fill(-1);
  let snapOwner = owner.slice(), snapOam = s.wram.slice(0x200, 0x4a0);
  // slots whose OAM entries were overwritten by another sprite in the same frame
  let conflicts = new Set<number>(), snapConflicts = conflicts;
  let lost = new Set<number>(), snapLost = lost;
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
        snapLost = lost;
        lost = new Set();
      }
      if (a >= 0x200 && a < 0x400) {
        const e = (a - 0x200) >> 2, prev = owner[e];
        if (cur >= 0 && prev >= 0 && prev !== cur) {
          conflicts.add(prev); conflicts.add(cur);
          const y = s.wram[0x201 + e * 4]; // still the overwritten tile's: the first write of cur
          if (y < 0xe0 || y >= 0xf8) { lost.add(prev); lost.add(cur); }
        }
        owner[e] = cur;
      }
    },
  };
  try {
    let guard = 0;
    while (s.wram[0x100] !== 0x14 && guard++ < 80) s.runFrame();
    for (let f = 0; f < frames; f++) s.runFrame();
  } catch { return null; } finally { s.hook = null; }
  return { snapOwner, snapOam, snapConflicts, snapLost };
}

// image of OAM tiles; ox/oy: its top-left on the screen
function drawTiles(emu: LevelEmulator, g: OamTile[]): SpriteImage | null {
  const s = emu.snes;
  const obsel = s.ppuRegs[0x01];
  const base = (obsel & 7) << 14;
  const gap = (((obsel >> 3) & 3) + 1) << 13;
  const pal = cgramToRGBA(s.cgram);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const t of g) {
    const sz = t.big ? 16 : 8;
    x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x + sz); y1 = Math.max(y1, t.y + sz);
  }
  const W = x1 - x0, H = y1 - y0;
  if (W <= 0 || H <= 0 || W > 256 || H > 256) return null;
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
  // nothing visible (e.g. tiles of graphics the level does not load): no image, the editor marks the spot
  if (!rgba.some((c) => c !== 0)) return null;
  return { w: W, h: H, ox: x0, oy: y0, rgba };
}

// Sprite num as it looks at tile X & 15 = x, Y & 15 = y (sprites that start differently depending
// on their position, see SpriteVariants): spawned alone into the empty level with the camera
// centered on it, so every position is fully on screen.
export function captureSpriteAt(
  emu: LevelEmulator, level: number, header: PrimaryHeader, spriteHeader: number, bgPointer: number, num: number, x: number, y: number,
): SpriteImage | null {
  const hdr = encodePrimaryHeader({ ...header, mode: 0, screens: 4, time: 2 });
  const r = emu.load(level, { layer1: new Uint8Array([...hdr, 0xff]), sprites: new Uint8Array([spriteHeader & 0x3f, 0xff]), secondaryHeader: [0, 0, 0, 0], layer2Pointer: bgPointer });
  if (!r.ok) return null;
  const s = emu.snes, w = s.wram;
  try {
    let guard = 0;
    while (w[0x100] !== 0x14 && guard++ < 80) s.runFrame();
  } catch { return null; }
  const tx = 32 + x, ty = 6 + ((y - 6) & 15), px = tx * 16, py = ty * 16;
  const cx = px - 0x70, cy = Math.max(0, Math.min(0x1b * 16 - 224, py - 0x70));
  w[0x1a] = w[0x1462] = cx & 0xff; w[0x1b] = w[0x1463] = cx >> 8;
  w[0x1c] = w[0x1464] = cy & 0xff; w[0x1d] = w[0x1465] = cy >> 8;
  // Mario out of the way, left of the sprite
  const mx = px - 0x40;
  w[0x94] = w[0xd1] = mx & 0xff; w[0x95] = w[0xd2] = mx >> 8;
  w[0x96] = w[0xd3] = py & 0xff; w[0x97] = w[0xd4] = py >> 8;
  const slot = 11;
  emu.spawnSprite(slot, num, px, py);
  const rec = record(emu, 3);
  if (!rec || !w[0x14c8 + slot] || (num >= 0x200 ? w[0x1ab9e + slot] !== (num & 0xff) : w[0x9e + slot] !== num)) return null;
  const g = readOamBuffer(rec.snapOam).filter((t) => rec.snapOwner[t.i] === slot);
  const img = g.length ? drawTiles(emu, g) : null;
  if (!img) return null;
  // offset relative to the sprite's position (it may have moved), the camera may have scrolled
  const sx = w[0xe4 + slot] | (w[0x14e0 + slot] << 8), sy = w[0xd8 + slot] | (w[0x14d4 + slot] << 8);
  const ncx = w[0x1a] | (w[0x1b] << 8), ncy = w[0x1c] | (w[0x1d] << 8);
  return { ...img, ox: img.ox + ncx - sx, oy: img.oy + ncy - sy };
}
