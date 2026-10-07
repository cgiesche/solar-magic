// Sprite memory ($1692, sprite header bits 0-5): which OAM range each sprite slot gets. When a
// slot's range is too small for its sprite, the next slot drawn overwrites tiles of it and parts
// of the graphics are missing (in the game as in the editor). Found by emulation: the sprites
// that can be on screen together are loaded into the empty test level and run; the OAM writes
// show which slots lost visible tiles to another one.

import { LevelEmulator } from './levelemu.ts';
import { loadLevel, spriteSizes, type LevelSprite, type PrimaryHeader } from './level.ts';
import { record, sortPlaced, testLevel, testSpriteData } from './spritegfx.ts';
import type { Rom } from './rom.ts';
import { SPR, SPRITE_SLOTS, spriteX, spriteY, cameraX, cameraY } from './ram.ts';

const SCREEN_W = 16, SCREEN_H = 14; // tiles

export interface SpriteMemCheck {
  conflicts: Set<number>; // uids of sprites drawn incompletely
  live: number[]; // per window: how many of its sprites are alive (fewer = the setting has fewer slots)
}

export interface SpriteMemContext {
  emu: LevelEmulator;
  level: number;
  header: PrimaryHeader;
  bgPointer: number;
}

// Groups of sprites that fit on one screen together (maximal sets, an isolated sprite alone: group
// sprites like $E0 spawn several slots by themselves)
export function spriteWindows(sprites: LevelSprite[]): LevelSprite[][] {
  const byX = [...sprites].sort((a, b) => a.x - b.x || a.y - b.y);
  const sets: LevelSprite[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < byX.length; i++) {
    const col = byX.filter((s) => s.x >= byX[i].x && s.x < byX[i].x + SCREEN_W);
    for (const top of col) {
      const w = col.filter((s) => s.y >= top.y && s.y < top.y + SCREEN_H);
      const key = w.map((s) => s.uid).sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      sets.push(w);
    }
  }
  const ids = sets.map((w) => new Set(w.map((s) => s.uid)));
  return sets.filter((w, i) => !ids.some((o, j) => j !== i && o.size > w.length && w.every((s) => o.has(s.uid))));
}

// Runs one window with sprite memory m; null when the load fails
function runWindow(ctx: SpriteMemContext, m: number, win: LevelSprite[], cam: { camX: number; camY: number; l1: Uint8Array; secondary: number[] }): { lost: Set<number>; live: number } | null {
  const { emu, level, bgPointer } = ctx;
  // the window centered on the screen (sprites near an edge would be drawn partly off screen)
  const xs = win.map((s) => s.x), ys = win.map((s) => s.y);
  const x0 = Math.min(...xs) - ((SCREEN_W - 1 - Math.max(...xs) + Math.min(...xs)) >> 1);
  const y0 = Math.min(...ys) - ((SCREEN_H - 1 - Math.max(...ys) + Math.min(...ys)) >> 1);
  const placed = win.map((s) => ({ n: s.num, extra: s.extra, bytes: s.bytes, uid: s.uid, tx: (cam.camX >> 4) + s.x - x0, ty: (cam.camY >> 4) + s.y - y0 }));
  const order = sortPlaced(placed);
  const r = emu.load(level, { layer1: cam.l1, sprites: testSpriteData(m, order, spriteSizes(emu.rom)), secondaryHeader: cam.secondary, layer2Pointer: bgPointer });
  if (!r.ok) return null;
  const rec = record(emu, 3);
  if (!rec) return null;
  const w = emu.snes.wram;
  const lost = new Set<number>();
  let live = 0;
  const cx = cameraX(w), cy = cameraY(w);
  for (let i = 0; i < SPRITE_SLOTS; i++) {
    if (!w[SPR.status + i]) continue;
    live++;
    if (!rec.snapLost.has(i)) continue;
    // a slot spawned by another sprite (the platforms of $E0: $161A = $FF) counts for the nearest one
    let p = order[w[SPR.loadIndex + i]];
    if (!p) {
      const x = spriteX(w, i) - cx, y = spriteY(w, i) - cy;
      const d = (q: typeof p) => Math.abs(q.tx * 16 - (cam.camX & ~15) - x) + Math.abs(q.ty * 16 - (cam.camY & ~15) - y);
      p = order.reduce((a, b) => (d(b) < d(a) ? b : a));
    }
    lost.add(p.uid);
  }
  return { lost, live };
}

export function checkSpriteMemory(ctx: SpriteMemContext, m: number, windows: LevelSprite[][]): SpriteMemCheck {
  return runJob(checkJob(ctx, m, windows));
}

function runJob<T>(job: Generator<void, T>): T {
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}

// the check as steps (one window each) for running in the background
function* checkJob(ctx: SpriteMemContext, m: number, windows: LevelSprite[][]): Generator<void, SpriteMemCheck> {
  const cam = testLevel(ctx.emu, ctx.level, ctx.header, m, ctx.bgPointer);
  const conflicts = new Set<number>(), live: number[] = [];
  for (const win of windows) {
    yield;
    const r = runWindow(ctx, m, win, cam);
    live.push(r?.live ?? -1);
    r?.lost.forEach((u) => conflicts.add(u));
  }
  return { conflicts, live };
}

// Sprite memory values the ROM's own levels use, most used first
export function usedSpriteMemory(rom: Rom): number[] {
  const count = new Map<number, number>();
  for (let n = 0; n < 0x200; n++) {
    try {
      const m = loadLevel(rom, n).spriteHeader & 0x3f;
      count.set(m, (count.get(m) ?? 0) + 1);
    } catch { /* unreadable level */ }
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([m]) => m);
}

// A value for which all windows are free of conflicts and keep as many sprites alive as with the
// current one (base: its check), tried in the order given (most used first); null if none.
// Windows with conflicts are tried first, so a candidate usually fails fast.
export function suggestSpriteMemory(ctx: SpriteMemContext, current: number, candidates: number[], windows: LevelSprite[][], base: SpriteMemCheck): number | null {
  return runJob(suggestJob(ctx, current, candidates, windows, base));
}

function* suggestJob(ctx: SpriteMemContext, current: number, candidates: number[], windows: LevelSprite[][], base: SpriteMemCheck): Generator<void, number | null> {
  const bad = windows.map((w, i) => i).filter((i) => windows[i].some((s) => base.conflicts.has(s.uid)));
  if (!bad.length) return null;
  const order = [...bad, ...windows.map((_, i) => i).filter((i) => !bad.includes(i))];
  for (const m of candidates) {
    if (m === current) continue;
    yield;
    const cam = testLevel(ctx.emu, ctx.level, ctx.header, m, ctx.bgPointer);
    let ok = true;
    for (const i of order) {
      yield;
      const r = runWindow(ctx, m, windows[i], cam);
      if (!r || r.lost.size || r.live < base.live[i]) { ok = false; break; }
    }
    if (ok) return m;
  }
  return null;
}

// Check of the level's sprites with sprite memory m and, when sprites are drawn incompletely, a
// value that fixes it; as steps (each a level load or two) for running in the background
export function* spriteMemJob(ctx: SpriteMemContext, m: number, candidates: number[], sprites: LevelSprite[]): Generator<void, { check: SpriteMemCheck; suggestion: number | null }> {
  const windows = spriteWindows(sprites);
  const check = yield* checkJob(ctx, m, windows);
  const suggestion = check.conflicts.size ? yield* suggestJob(ctx, m, candidates, windows, check) : null;
  return { check, suggestion };
}
