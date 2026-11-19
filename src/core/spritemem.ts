// Sprite memory ($1692, sprite header bits 0-5): which OAM range each sprite slot gets. When a
// slot's range is too small for its sprite, the next slot drawn overwrites tiles of it and parts
// of the graphics are missing (in the game as in the editor). Found by emulation: the sprites
// that can be in one view together are loaded into the empty test level and run; the OAM writes
// show which slots lost visible tiles to another one.
// It also sets the slots level sprites load into, and some values keep a slot for one sprite only (04: one Banzai
// Bill, in slot 0; a second one is skipped while the first is alive, without a slot search). A sprite of a group
// that has no slot when the group is loaded, while it has one when loaded alone with the same value, is missing: it
// does not appear (the loader found no slot for it; the next time it comes into view it may).
// Each group of sprites that fit in a view together is run on its own; its result can be kept between
// checks (SpriteGroupResults): after a sprite change a check runs only the groups that changed (a group
// moved as a whole is played the same: its result is kept by its sprites' places relative to each other).

import { LevelEmulator } from './levelemu.ts';
import { loadLevel, spriteSizes, SPRITE_MEMORY, type Level, type LevelSprite, type PrimaryHeader } from './level.ts';
import { record, rootSlot, sortPlaced, SlotTracker, testLevel, testSpriteData } from './spritegfx.ts';
import { runJob } from './jobrunner.ts';
import { KeptResults } from './keptresults.ts';
import { inputHash } from './inputs.ts';
import { RomReads, byFingerprint, type RomDeps, type RomFingerprint } from './romdeps.ts';
import type { Rom } from './rom.ts';
import { SPR, SPRITE_SLOTS, spriteX, spriteY, cameraX, cameraY } from './ram.ts';
import { GAME_VIEW_W, GAME_VIEW_H } from './camerabands.ts';

const VIEW_W = GAME_VIEW_W / 16, VIEW_H = GAME_VIEW_H / 16; // tiles

export interface SpriteMemCheck {
  conflicts: Set<number>; // uids of sprites drawn incompletely
  missing: Set<number>; // uids of sprites that don't appear: no slot when a group is loaded, one when alone
  live: number[]; // per group: how many of its sprites are alive (fewer = the setting has fewer slots)
}

export interface SpriteMemContext {
  emu: LevelEmulator;
  level: number;
  header: PrimaryHeader;
  bgPointer: number;
  groupResults?: SpriteGroupResults; // results of single groups kept between checks
}

// group results kept, the latest used (of all levels): a level's groups with the values a suggestion tries, so a
// search plays a group only with values not played before (about 6 KB each in level 105: the pages and bytes read);
// a check keeps all it used, also more (a very large level)
const KEPT_GROUPS = 1024;

// The results of single groups (a group with a sprite memory value in a level with its header and BG: which of
// its sprites lost tiles, how many are alive), kept in memory while the ROM bytes they read are unchanged; a check
// takes over a kept group's dependencies (a stored check depends on them as if it had run the group)
export class SpriteGroupResults {
  private fp: RomFingerprint;
  private kept: KeptResults<RomDeps>;

  constructor(fp: RomFingerprint, limit = KEPT_GROUPS) {
    this.fp = fp;
    this.kept = new KeptResults({ validity: byFingerprint(fp), limit });
  }

  // a check starts or is finished: the results a finished check used are all kept for the next one
  startCheck(): void { this.kept.startRound(); }
  endCheck(): void { this.kept.endRound(); }

  get(key: string): GroupResult | undefined {
    const e = this.kept.entry<GroupResult['check']>(key);
    return e && { check: e.data, deps: e.deps };
  }
  set(key: string, check: GroupResult['check'], reads: RomReads): void { this.kept.set(key, check, this.fp.deps(reads)); }
}

// lost: indices in the group drawn incompletely, absent: indices without a slot when loaded; null: the load failed
export interface GroupResult { check: { lost: number[]; absent: number[]; live: number } | null; deps: RomDeps }

type Cam = ReturnType<typeof testLevel>;
// the test level's camera per sprite memory value, found once per job (again when the ROM changed meanwhile)
type Cams = Map<number, { gen: number; cam: Cam; reads: RomReads }>;

// A sprite group (CONTEXT.md): a largest set of the level's sprites that fit in one view together, played as one
export type SpriteGroup = LevelSprite[];

// The level's sprite groups: the sprites that fit in one view together (maximal sets, an isolated
// sprite alone: a group sprite like $E0 spawns several slots by itself)
export function spriteGroups(sprites: LevelSprite[]): SpriteGroup[] {
  const byX = [...sprites].sort((a, b) => a.x - b.x || a.y - b.y);
  const sets: SpriteGroup[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < byX.length; i++) {
    const col = byX.filter((s) => s.x >= byX[i].x && s.x < byX[i].x + VIEW_W);
    for (const top of col) {
      const g = col.filter((s) => s.y >= top.y && s.y < top.y + VIEW_H);
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
function runGroup(ctx: SpriteMemContext, m: number, group: SpriteGroup, cam: Cam): GroupCheck {
  const { emu, level, bgPointer } = ctx;
  // the group centered in the view (sprites near an edge would be drawn partly out of view)
  const xs = group.map((s) => s.x), ys = group.map((s) => s.y);
  const x0 = Math.min(...xs) - ((VIEW_W - 1 - Math.max(...xs) + Math.min(...xs)) >> 1);
  const y0 = Math.min(...ys) - ((VIEW_H - 1 - Math.max(...ys) + Math.min(...ys)) >> 1);
  const placed = group.map((s) => ({ n: s.num, extra: s.extra, bytes: s.bytes, uid: s.uid, tx: (cam.camX >> 4) + s.x - x0, ty: (cam.camY >> 4) + s.y - y0 }));
  const order = sortPlaced(placed);
  const tracker = new SlotTracker(emu.snes);
  const r = emu.load(level, { layer1: cam.l1, sprites: testSpriteData(m, order, spriteSizes(emu.rom)), secondaryHeader: cam.secondary, layer2Pointer: bgPointer, fadeHook: tracker.start });
  if (!r.ok) return null;
  const w = emu.snes.wram;
  // the sprites that got a slot when loaded (some die in the frames after: a line-guided one without a line)
  const present = new Set<number>();
  for (let i = 0; i < SPRITE_SLOTS; i++) if (w[SPR.status + i] && order[w[SPR.loadIndex + i]]) present.add(order[w[SPR.loadIndex + i]].uid);
  const rec = record(emu, 3, tracker);
  if (!rec) return null;
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
  return { lost, absent: new Set(group.filter((s) => !present.has(s.uid)).map((s) => s.uid)), live };
}

// lost, absent: uids
type GroupCheck = { lost: Set<number>; absent: Set<number>; live: number } | null;

// The key of a group's result with sprite memory m: all it depends on (the suggestion tries more values per group
// than a key keeps inputs for); the sprites by their places relative to each other, as runGroup plays them
function groupKey(ctx: SpriteMemContext, m: number, group: SpriteGroup): string {
  const x0 = Math.min(...group.map((s) => s.x)), y0 = Math.min(...group.map((s) => s.y));
  return `smg3:${ctx.level}:${inputHash({ header: ctx.header, bg: ctx.bgPointer, m, sprites: group.map((s) => [s.num, s.x - x0, s.y - y0, s.extra, s.bytes ?? []]) })}`;
}

// A group's kept result with sprite memory m (the check takes over its dependencies); undefined if none is kept
function keptGroup(ctx: SpriteMemContext, m: number, group: SpriteGroup, key = groupKey(ctx, m, group)): GroupCheck | undefined {
  const known = ctx.groupResults?.get(key);
  if (!known) return undefined;
  ctx.emu.rom.reads?.addDeps(known.deps);
  const uids = (ix: number[]) => new Set(ix.map((i) => group[i].uid));
  return known.check && { lost: uids(known.check.lost), absent: uids(known.check.absent), live: known.check.live };
}

// The check of one group with sprite memory m: its kept result, else run (and kept)
function checkGroup(ctx: SpriteMemContext, m: number, group: SpriteGroup, cams: Cams): GroupCheck {
  const { emu, groupResults } = ctx;
  const key = groupResults ? groupKey(ctx, m, group) : '';
  const kept = groupResults ? keptGroup(ctx, m, group, key) : undefined;
  if (kept !== undefined) return kept;
  let c = cams.get(m);
  if (!c || c.gen !== emu.rom.gen) {
    const r = emu.record('behaviour', () => testLevel(emu, ctx.level, ctx.header, m, ctx.bgPointer));
    cams.set(m, (c = { gen: emu.rom.gen, cam: r.result, reads: r.reads }));
  }
  const cam = c.cam, { result, reads } = emu.record('behaviour', () => runGroup(ctx, m, group, cam), { base: c.reads });
  if (groupResults) {
    const ix = (uids: Set<number>) => group.flatMap((s, i) => (uids.has(s.uid) ? [i] : []));
    groupResults.set(key, result && { lost: ix(result.lost), absent: ix(result.absent), live: result.live }, reads);
  }
  return result;
}

// The sprites of a group (its check r) that are missing: without a slot in it, with one when loaded alone (a sprite
// that never takes one, a generator or shooter, isn't); cams null: only kept results are used, undefined when one isn't
function groupMissing(ctx: SpriteMemContext, m: number, group: SpriteGroup, r: NonNullable<GroupCheck>, cams: Cams | null): Set<number> | undefined {
  const missing = new Set<number>();
  if (group.length < 2) return missing;
  for (const s of group) {
    if (!r.absent.has(s.uid)) continue;
    const alone = cams ? checkGroup(ctx, m, [s], cams) : keptGroup(ctx, m, [s]);
    if (alone === undefined) return undefined;
    if (alone && !alone.absent.has(s.uid)) missing.add(s.uid);
  }
  return missing;
}

export function checkSpriteMemory(ctx: SpriteMemContext, m: number, groups: SpriteGroup[]): SpriteMemCheck {
  return runJob(checkJob(ctx, m, groups));
}

// the check as steps (one group each) for running in the background
function* checkJob(ctx: SpriteMemContext, m: number, groups: SpriteGroup[], cams: Cams = new Map()): Generator<void, SpriteMemCheck> {
  const conflicts = new Set<number>(), missing = new Set<number>(), live: number[] = [];
  for (const group of groups) {
    yield;
    const r = checkGroup(ctx, m, group, cams);
    live.push(r?.live ?? -1);
    r?.lost.forEach((u) => conflicts.add(u));
    if (r?.absent.size) groupMissing(ctx, m, group, r, cams)!.forEach((u) => missing.add(u));
  }
  return { conflicts, missing, live };
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

// A value for which all groups are free of conflicts and missing sprites and keep as many sprites alive as with the
// current one (base: its check), tried in the order given (most used first); null if none.
// A value is first checked against the kept group results (one that fails rules it out without playing a group),
// then the other groups are played, those with conflicts first, so a candidate usually fails fast. Only the chosen
// value's reads count for an enclosing record() call (a stored check depends on the current value and the suggestion);
// when none fits, the reads of every value tried count (a ROM change that lets one fit checks again, #219).
export function suggestSpriteMemory(ctx: SpriteMemContext, current: number, candidates: number[], groups: SpriteGroup[], base: SpriteMemCheck): number | null {
  return runJob(suggestJob(ctx, current, candidates, groups, base));
}

function* suggestJob(ctx: SpriteMemContext, current: number, candidates: number[], groups: SpriteGroup[], base: SpriteMemCheck, cams: Cams = new Map()): Generator<void, number | null> {
  const bad = groups.map((_, i) => i).filter((i) => groups[i].some((s) => base.conflicts.has(s.uid) || base.missing.has(s.uid)));
  if (!bad.length) return null;
  const order = [...bad, ...groups.map((_, i) => i).filter((i) => !bad.includes(i))];
  // a group's check fails the value (missing: undefined while a sprite's check alone isn't kept)
  const fails = (i: number, r: GroupCheck, missing: Set<number> | undefined) => !r || r.lost.size > 0 || r.live < base.live[i] || !!missing?.size;
  const { emu } = ctx;
  const rejected = new RomReads(emu.rom); // the reads of the values rejected
  for (const m of candidates) {
    if (m === current) continue;
    // what the value's checks read counts only when it is chosen or none fits (#219): a ROM change that lets a rejected
    // value fit checks again only when there is no suggestion (one that fits is enough, maybe not the first)
    const reads = new RomReads(emu.rom);
    const apart = <T>(fn: () => T): T => { const r = emu.record('behaviour', fn, { base: null, counted: false }); reads.add(r.reads); return r.result; };
    const play: number[] = [];
    let ok = true;
    for (const i of order) {
      const r = apart(() => keptGroup(ctx, m, groups[i]));
      const missing = r ? apart(() => groupMissing(ctx, m, groups[i], r, null)) : new Set<number>();
      if (r === undefined || (missing === undefined && !fails(i, r, undefined))) play.push(i);
      else if (fails(i, r, missing)) { ok = false; break; }
    }
    for (const i of ok ? play : []) {
      yield;
      const r = apart(() => checkGroup(ctx, m, groups[i], cams));
      if (fails(i, r, r ? apart(() => groupMissing(ctx, m, groups[i], r, cams)) : undefined)) { ok = false; break; }
    }
    if (ok) { emu.count(reads); return m; }
    rejected.add(reads);
  }
  emu.count(rejected);
  return null;
}

// Check of the level's sprites with sprite memory m and, when sprites are drawn incompletely or missing, a
// value that fixes it; as steps (each a level load or two) for running in the background. With ctx.groupResults only
// the groups not kept run.
export function* spriteMemJob(ctx: SpriteMemContext, m: number, candidates: number[], sprites: LevelSprite[]): Generator<void, { check: SpriteMemCheck; suggestion: number | null }> {
  const groups = spriteGroups(sprites), cams: Cams = new Map();
  ctx.groupResults?.startCheck();
  const check = yield* checkJob(ctx, m, groups, cams);
  const suggestion = check.conflicts.size || check.missing.size ? yield* suggestJob(ctx, m, candidates, groups, check, cams) : null;
  ctx.groupResults?.endCheck();
  return { check, suggestion };
}

// The sprite memory check of a level's sprites (the result learner's job, no picture): the level with its header and
// BG, its sprite memory value, the values a suggestion tries and its sprites (in an order that doesn't change
// between sessions: the result is kept by their indices)
export interface SpriteMemLevel { number: number; header: PrimaryHeader; bgPointer: number; mem: number; candidates: number[]; sprites: LevelSprite[] }
// lost: indices of sprites drawn incompletely, missing: of sprites that don't appear
export interface SpriteMemResult { lost: number[]; missing: number[]; suggestion: number | null }

// The sprite memory check of a level as edited (lv) as a learn job: its result's key and input, the level it checks
// (candidates: the values a suggestion tries, usedSpriteMemory) and checked: key and input in one (whether a check
// shown is this one). The test level it plays: the level's header and BG, its sprites in canonical order (the result
// is kept by their indices, uids differ between sessions).
export function spriteMemSpec(lv: Level, candidates: number[]): { key: string; input: object; checked: string; level: SpriteMemLevel } {
  const mem = lv.spriteHeader & SPRITE_MEMORY;
  const sprites = [...lv.sprites].sort((a, b) => a.x - b.x || a.y - b.y || a.num - b.num || a.extra - b.extra);
  const bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900, header = { ...lv.header };
  const input = { mem, header, bg, candidates, sprites: sprites.map((q) => [q.num, q.x, q.y, q.extra, q.bytes ?? []]) };
  const key = `sm4:${lv.number}`;
  return { key, input, checked: `${key}#${inputHash(input)}`, level: { number: lv.number, header, bgPointer: bg, mem, candidates, sprites } };
}

// the uids of the level's sprites a check (spriteMemSpec's level) found drawn incompletely
export const lostSprites = (l: SpriteMemLevel, r: SpriteMemResult): number[] => r.lost.map((i) => l.sprites[i].uid);
// the uids of the level's sprites a check found missing
export const missingSprites = (l: SpriteMemLevel, r: SpriteMemResult): number[] => r.missing.map((i) => l.sprites[i].uid);

// spriteMemJob with the result by the sprites' indices
export function* spriteMemCheckJob(emu: LevelEmulator, l: SpriteMemLevel, groupResults?: SpriteGroupResults): Generator<void, SpriteMemResult> {
  const r = yield* spriteMemJob({ emu, level: l.number, header: l.header, bgPointer: l.bgPointer, groupResults }, l.mem, l.candidates, l.sprites);
  const ix = (uids: Set<number>) => [...uids].map((u) => l.sprites.findIndex((q) => q.uid === u));
  return { lost: ix(r.check.conflicts), missing: ix(r.check.missing), suggestion: r.suggestion };
}
