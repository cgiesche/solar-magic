// Sprite memory ($1692, sprite header bits 0-5): which OAM range each sprite slot gets. When a
// slot's range is too small for its sprite, the next slot drawn overwrites tiles of it and parts
// of the graphics are missing (in the game as in the editor). Found by emulation: the sprites
// that can be on screen together are loaded into the empty test level and run; the OAM writes
// show which slots lost visible tiles to another one.
// Each group of sprites that fit on a screen together is run on its own; its result can be kept between
// checks (SpriteGroupResults): after a sprite change a check runs only the groups that changed.

import { LevelEmulator } from './levelemu.ts';
import { loadLevel, spriteSizes, SPRITE_MEMORY, type LevelSprite, type PrimaryHeader } from './level.ts';
import { record, rootSlot, sortPlaced, SlotTracker, testLevel, testSpriteData } from './spritegfx.ts';
import { MemoryResults } from './learner.ts';
import { inputHash } from './inputs.ts';
import type { RomFingerprint, RomReads } from './romdeps.ts';
import type { Rom } from './rom.ts';
import { SPR, SPRITE_SLOTS, spriteX, spriteY, cameraX, cameraY } from './ram.ts';

const SCREEN_W = 16, SCREEN_H = 14; // tiles

export interface SpriteMemCheck {
  conflicts: Set<number>; // uids of sprites drawn incompletely
  live: number[]; // per group: how many of its sprites are alive (fewer = the setting has fewer slots)
}

export interface SpriteMemContext {
  emu: LevelEmulator;
  level: number;
  header: PrimaryHeader;
  bgPointer: number;
  groupResults?: SpriteGroupResults; // results of single groups kept between checks
}

const KEPT_GROUPS = 256; // group results kept, the latest used

// The results of single groups (a group with a sprite memory value in a level with its header and BG: which of
// its sprites lost tiles, how many are alive), kept in memory while the ROM bytes they read are unchanged; a check
// takes over a kept group's reads (a stored check depends on them as if it had run the group)
export class SpriteGroupResults {
  private fp: RomFingerprint;
  private kept: MemoryResults;

  constructor(fp: RomFingerprint) {
    this.fp = fp;
    this.kept = new MemoryResults(fp, KEPT_GROUPS);
  }

  get(key: string): GroupResult | undefined { return this.kept.get<GroupResult>(key, undefined); }
  set(key: string, r: GroupResult): void { this.kept.set(key, r, this.fp.deps(r.reads), undefined); }
}

// lost: indices in the group; null: the load failed
export interface GroupResult { check: { lost: number[]; live: number } | null; reads: RomReads }

type Cam = ReturnType<typeof testLevel>;
// the test level's camera per sprite memory value, found once per job (again when the ROM changed meanwhile)
type Cams = Map<number, { gen: number; cam: Cam; reads: RomReads }>;

// The level's sprite groups: the sprites that fit on one screen together (maximal sets, an isolated
// sprite alone: sprites like $E0 spawn several slots by themselves)
export function spriteGroups(sprites: LevelSprite[]): LevelSprite[][] {
  const byX = [...sprites].sort((a, b) => a.x - b.x || a.y - b.y);
  const sets: LevelSprite[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < byX.length; i++) {
    const col = byX.filter((s) => s.x >= byX[i].x && s.x < byX[i].x + SCREEN_W);
    for (const top of col) {
      const g = col.filter((s) => s.y >= top.y && s.y < top.y + SCREEN_H);
      const key = g.map((s) => s.uid).sort((a, b) => a - b).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      sets.push(g);
    }
  }
  const ids = sets.map((g) => new Set(g.map((s) => s.uid)));
  return sets.filter((g, i) => !ids.some((o, j) => j !== i && o.size > g.length && g.every((s) => o.has(s.uid))));
}

// Runs one group with sprite memory m; null when the load fails
function runGroup(ctx: SpriteMemContext, m: number, group: LevelSprite[], cam: { camX: number; camY: number; l1: Uint8Array; secondary: number[] }): { lost: Set<number>; live: number } | null {
  const { emu, level, bgPointer } = ctx;
  // the group centered on the screen (sprites near an edge would be drawn partly off screen)
  const xs = group.map((s) => s.x), ys = group.map((s) => s.y);
  const x0 = Math.min(...xs) - ((SCREEN_W - 1 - Math.max(...xs) + Math.min(...xs)) >> 1);
  const y0 = Math.min(...ys) - ((SCREEN_H - 1 - Math.max(...ys) + Math.min(...ys)) >> 1);
  const placed = group.map((s) => ({ n: s.num, extra: s.extra, bytes: s.bytes, uid: s.uid, tx: (cam.camX >> 4) + s.x - x0, ty: (cam.camY >> 4) + s.y - y0 }));
  const order = sortPlaced(placed);
  const tracker = new SlotTracker(emu.snes);
  const r = emu.load(level, { layer1: cam.l1, sprites: testSpriteData(m, order, spriteSizes(emu.rom)), secondaryHeader: cam.secondary, layer2Pointer: bgPointer, fadeHook: tracker.start });
  if (!r.ok) return null;
  const rec = record(emu, 3, tracker);
  if (!rec) return null;
  const w = emu.snes.wram;
  const lost = new Set<number>();
  let live = 0;
  const cx = cameraX(w), cy = cameraY(w);
  for (let i = 0; i < SPRITE_SLOTS; i++) {
    if (!w[SPR.status + i]) continue;
    live++;
    if (!rec.snapLost.has(i)) continue;
    // a slot spawned by sprite code counts for the sprite that spawned it, one spawned otherwise
    // (the platforms of $E0: $161A = $FF) for the nearest one
    let p = order[w[SPR.loadIndex + rootSlot(rec.spawner, i)]];
    if (!p) {
      const x = spriteX(w, i) - cx, y = spriteY(w, i) - cy;
      const d = (q: typeof p) => Math.abs(q.tx * 16 - (cam.camX & ~15) - x) + Math.abs(q.ty * 16 - (cam.camY & ~15) - y);
      p = order.reduce((a, b) => (d(b) < d(a) ? b : a));
    }
    lost.add(p.uid);
  }
  return { lost, live };
}

// The check of one group with sprite memory m: its kept result, else run (and kept). The key holds all a
// group's result depends on (the suggestion tries more values per group than a key keeps inputs for).
function checkGroup(ctx: SpriteMemContext, m: number, group: LevelSprite[], cams: Cams): { lost: Set<number>; live: number } | null {
  const { emu, groupResults } = ctx;
  let key: string | undefined;
  if (groupResults) {
    key = `smg1:${ctx.level}:${inputHash({ header: ctx.header, bg: ctx.bgPointer, m, sprites: group.map((s) => [s.num, s.x, s.y, s.extra, s.bytes ?? []]) })}`;
    const known = groupResults.get(key);
    if (known) {
      emu.rom.reads?.add(known.reads);
      return known.check && { lost: new Set(known.check.lost.map((i) => group[i].uid)), live: known.check.live };
    }
  }
  let c = cams.get(m);
  if (!c || c.gen !== emu.rom.gen) {
    const r = emu.tracked(() => testLevel(emu, ctx.level, ctx.header, m, ctx.bgPointer));
    cams.set(m, (c = { gen: emu.rom.gen, cam: r.result, reads: r.reads }));
  }
  const cam = c.cam, { result, reads } = emu.tracked(() => runGroup(ctx, m, group, cam), c.reads);
  if (groupResults && key) {
    const lost = result && group.flatMap((s, i) => (result.lost.has(s.uid) ? [i] : []));
    groupResults.set(key, { check: result && { lost: lost!, live: result.live }, reads });
  }
  return result;
}

export function checkSpriteMemory(ctx: SpriteMemContext, m: number, groups: LevelSprite[][]): SpriteMemCheck {
  return runJob(checkJob(ctx, m, groups));
}

function runJob<T>(job: Generator<void, T>): T {
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}

// the check as steps (one group each) for running in the background
function* checkJob(ctx: SpriteMemContext, m: number, groups: LevelSprite[][], cams: Cams = new Map()): Generator<void, SpriteMemCheck> {
  const conflicts = new Set<number>(), live: number[] = [];
  for (const group of groups) {
    yield;
    const r = checkGroup(ctx, m, group, cams);
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
      const m = loadLevel(rom, n).spriteHeader & SPRITE_MEMORY;
      count.set(m, (count.get(m) ?? 0) + 1);
    } catch { /* unreadable level */ }
  }
  return [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([m]) => m);
}

// A value for which all groups are free of conflicts and keep as many sprites alive as with the
// current one (base: its check), tried in the order given (most used first); null if none.
// Groups with conflicts are tried first, so a candidate usually fails fast.
export function suggestSpriteMemory(ctx: SpriteMemContext, current: number, candidates: number[], groups: LevelSprite[][], base: SpriteMemCheck): number | null {
  return runJob(suggestJob(ctx, current, candidates, groups, base));
}

function* suggestJob(ctx: SpriteMemContext, current: number, candidates: number[], groups: LevelSprite[][], base: SpriteMemCheck, cams: Cams = new Map()): Generator<void, number | null> {
  const bad = groups.map((_, i) => i).filter((i) => groups[i].some((s) => base.conflicts.has(s.uid)));
  if (!bad.length) return null;
  const order = [...bad, ...groups.map((_, i) => i).filter((i) => !bad.includes(i))];
  for (const m of candidates) {
    if (m === current) continue;
    let ok = true;
    for (const i of order) {
      yield;
      const r = checkGroup(ctx, m, groups[i], cams);
      if (!r || r.lost.size || r.live < base.live[i]) { ok = false; break; }
    }
    if (ok) return m;
  }
  return null;
}

// Check of the level's sprites with sprite memory m and, when sprites are drawn incompletely, a
// value that fixes it; as steps (each a level load or two) for running in the background. With ctx.groupResults only
// the groups not kept run.
export function* spriteMemJob(ctx: SpriteMemContext, m: number, candidates: number[], sprites: LevelSprite[]): Generator<void, { check: SpriteMemCheck; suggestion: number | null }> {
  const groups = spriteGroups(sprites), cams: Cams = new Map();
  const check = yield* checkJob(ctx, m, groups, cams);
  const suggestion = check.conflicts.size ? yield* suggestJob(ctx, m, candidates, groups, check, cams) : null;
  return { check, suggestion };
}
