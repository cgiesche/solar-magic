// Sprite memory check (src/core/spritemem.ts): $E0 (three platforms on chains) in level 00C with
// its sprite memory 00 loses tiles, a suggested value shows all of them; levels keep their
// own value free of conflicts (no false alarms). With No More Sprite Tile Limits (the Romhack Races
// baserom's) two line-guided platforms ($62) next to each other lose nothing: the next sprite's tiles
// go where the first wrote only tile numbers of hidden tiles. With the groups' results kept, moving one sprite
// checks only the groups it was and is in, with the same conflicts and suggestion as a check of the whole level;
// no group is played twice with a value (the suggestion after a move that causes a conflict plays the untouched
// groups only with values not played before), moving all sprites plays no group again, and a kept result holds
// the compact dependencies (RomDeps), not the record of the ROM bytes read. A check keeps all group results it used
// for the next one, also more than the bound (#200). A check depends on the bytes read for the current value and the
// suggestion only, not a rejected value's; two groups with the same layout share a result (#208). Without a suggestion
// it depends on the bytes read for every value tried (#219).
// Usage: node tools/testspritemem.ts [levels,hex]
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { applyPatch } from '../src/core/patchapply.ts';
import { loadAsar } from '../src/core/asar.ts';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, newUid, type LevelSprite } from '../src/core/level.ts';
import { checkSpriteMemory, spriteMemJob, spriteGroups, suggestSpriteMemory, usedSpriteMemory, SpriteGroupResults, type GroupResult, type SpriteGroup, type SpriteMemContext } from '../src/core/spritemem.ts';
import { runJob } from '../src/core/jobrunner.ts';
import { PAGE_SHIFT, RomFingerprint, RomReads } from '../src/core/romdeps.ts';
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

const rom = new Rom(EDITOR_IMAGE.slice());
const emu = new LevelEmulator(rom);
emu.boot();
const bgOf = (p: number) => (p >> 16 === 0xff ? p : 0xffd900);
let bad = 0;
const fail = (msg: string) => { bad++; console.log('FAIL', msg); };
// group results that count the groups played, fail when one is played twice with a value or kept with its reads
class Counted extends SpriteGroupResults {
  ran = 0;
  private played = new Set<string>();
  private name: string;
  constructor(name: string, limit?: number) { super(new RomFingerprint(rom), limit); this.name = name; }
  set(key: string, check: GroupResult['check'], reads: RomReads): void {
    this.ran++;
    if (this.played.has(key)) fail(`${this.name}: a group played again with the same value`);
    this.played.add(key);
    super.set(key, check, reads);
    if (Object.values(this.get(key) ?? {}).some((v) => v instanceof RomReads)) fail(`${this.name}: a kept group holds its reads`);
  }
}
type Job = { check: { conflicts: Set<number>; live: number[] }; suggestion: number | null };
// the check and suggestion of a level's sprites with sprite memory m (with the kept groups if given)
const checkAndSuggest = (ctx: Omit<SpriteMemContext, 'groupResults'>, groupResults: SpriteGroupResults | undefined, m: number, sprites: LevelSprite[]): Job =>
  runJob(spriteMemJob({ ...ctx, groupResults }, m, candidates, sprites));
const same = (a: Job, b: Job) => a.suggestion === b.suggestion && a.check.live.join() === b.check.live.join() &&
  a.check.conflicts.size === b.check.conflicts.size && [...a.check.conflicts].every((u) => b.check.conflicts.has(u));
const candidates = usedSpriteMemory(rom);
console.log('used sprite memory', candidates.map((m) => m.toString(16)).join(' '));

// $E0 in level 00C
{
  const lv = loadLevel(rom, 0xc);
  const ctx = { emu, level: 0xc, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const groups: SpriteGroup[] = [[{ uid: newUid(), num: 0xe0, x: 8, y: 0x14, extra: 0 }]];
  const m = lv.spriteHeader & 0x3f;
  const base = checkSpriteMemory(ctx, m, groups);
  if (!base.conflicts.size) fail(`00C: $E0 with ${m.toString(16)} shows no conflict`);
  const s = suggestSpriteMemory(ctx, m, candidates, groups, base);
  if (s === null) fail('00C: no suggestion');
  else {
    const c = checkSpriteMemory(ctx, s, groups);
    if (c.conflicts.size || c.live[0] < base.live[0]) fail(`00C: suggestion ${s.toString(16)} does not help`);
    console.log(`00C $E0: ${m.toString(16)} → ${s.toString(16)}`);
  }
}

// two $62 with No More Sprite Tile Limits: its OAM slots are given out one after the other
{
  await loadAsar();
  const nmstl = new Rom(EDITOR_IMAGE.slice());
  const zip = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
  const r = applyPatch(nmstl, { name: 'nmstl', main: 'nmstl.asm', files: new Map([['nmstl.asm', zip['resources/patches/other/no_more_sprite_tile_limits.asm']]]) });
  if (r.errors.length) fail(`No More Sprite Tile Limits not applied: ${r.errors.join(' ')}`);
  const e = new LevelEmulator(nmstl); e.boot();
  const lv = loadLevel(nmstl, 0x105);
  const groups: SpriteGroup[] = [[{ uid: newUid(), num: 0x62, x: 3, y: 4, extra: 0 }, { uid: newUid(), num: 0x62, x: 14, y: 9, extra: 0 }]];
  const c = checkSpriteMemory({ emu: e, level: 0x105, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) }, 0x08, groups);
  if (c.conflicts.size || c.live[0] !== 2) fail(`No More Sprite Tile Limits: two $62 with conflicts (${c.conflicts.size}) or not both alive (${c.live[0]})`);
  else console.log('No More Sprite Tile Limits: two $62, no conflicts');
}

// kept group results: level 00C with $E0 (conflicts), then one sprite moved
{
  const lv = loadLevel(rom, 0xc);
  const ctx = { emu, level: 0xc, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const groupResults = new Counted('00C');
  const before: LevelSprite[] = [...lv.sprites, { uid: newUid(), num: 0xe0, x: 8, y: 0x14, extra: 0 }];
  const run = (sprites: LevelSprite[], kept: boolean) => checkAndSuggest(ctx, kept ? groupResults : undefined, 0, sprites);
  const first = run(before, true);
  if (!first.check.conflicts.size || first.suggestion === null) fail(`00C with $E0: no conflicts (${first.check.conflicts.size}) or no suggestion`);
  if (!same(first, run(before, false))) fail('00C: kept groups give another result than a check of the whole level');
  // a sprite of the level moved next to $E0: only the groups it was and is in run
  const moved = before.find((s) => s.num === 0x8f)!, to = { ...moved, x: 12 };
  const after = before.map((s) => (s === moved ? to : s));
  // a group as its sprites (uid and place); changed: groups of after that before didn't have
  const groupsOf = (sprites: LevelSprite[]) => spriteGroups(sprites).map((g) => g.map((s) => `${s.uid}@${s.x},${s.y}`));
  const old = groupsOf(before), oldKeys = new Set(old.map((g) => [...g].sort().join(' ')));
  const changed = groupsOf(after).filter((g) => !oldKeys.has([...g].sort().join(' ')));
  // each holds the moved sprite now or is what is left of a group it was in
  const had = (g: string[], uid: number) => g.some((p) => p.startsWith(`${uid}@`));
  if (changed.some((g) => !had(g, moved.uid) && !old.some((o) => had(o, moved.uid) && g.every((p) => o.includes(p))))) fail('00C: a changed group without the moved sprite');
  groupResults.ran = 0;
  const c = checkSpriteMemory({ ...ctx, groupResults }, 0, spriteGroups(after));
  if (groupResults.ran !== changed.length) fail(`00C: moving one sprite checked ${groupResults.ran} groups, ${changed.length} changed`);
  console.log(`00C one sprite moved: ${groupResults.ran} of ${c.live.length} groups checked`);
  const t0 = Date.now(), again = run(after, true), ms = Date.now() - t0;
  if (!same(again, run(after, false))) fail('00C: after the move kept groups give another result than a check of the whole level');
  console.log(`00C after the move: ${again.check.conflicts.size} conflicts, suggestion ${again.suggestion?.toString(16)} (${ms}ms with kept groups)`);
}

// level 105 with its own sprite memory: a sprite moved, the kept groups give the result of a whole check
{
  const lv = loadLevel(rom, 0x105), m = lv.spriteHeader & 0x3f;
  const ctx = { emu, level: 0x105, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const groupResults = new Counted('105');
  const run = (sprites: LevelSprite[], kept: boolean) => checkAndSuggest(ctx, kept ? groupResults : undefined, m, sprites);
  run(lv.sprites, true);
  const after = lv.sprites.map((s, i) => (i === 5 ? { ...s, x: s.x + 9 } : s));
  const t0 = Date.now(), kept = run(after, true), ms = Date.now() - t0, whole = run(after, false);
  if (!same(kept, whole)) fail('105: kept groups give another result than a check of the whole level');
  else console.log(`105 one sprite moved: same result as a whole check (${ms}ms with kept groups)`);
  // all sprites moved: every group moved as a whole, none played again
  const shifted = after.map((s) => ({ ...s, x: s.x + 5, y: s.y - 1 }));
  groupResults.ran = 0;
  const all = run(shifted, true);
  if (groupResults.ran) fail(`105: moving all sprites played ${groupResults.ran} groups again`);
  if (!same(all, run(shifted, false))) fail('105: all sprites moved, kept groups give another result than a check of the whole level');
  else console.log(`105 all sprites moved: ${groupResults.ran} groups played, same result as a whole check`);
  // a bound far below the level's groups: the check again plays none
  const small = new Counted('105 bound 2', 2);
  checkAndSuggest(ctx, small, m, lv.sprites);
  const played = small.ran;
  small.ran = 0;
  // one sprite moved: only its groups are played (a replay of another fails), the others still kept
  checkAndSuggest(ctx, small, m, after);
  const moved = small.ran;
  small.ran = 0;
  checkAndSuggest(ctx, small, m, lv.sprites);
  if (played <= 2 || small.ran) fail(`105 with a bound of 2: ${played} groups played, again ${small.ran}`);
  else console.log(`105 with a bound of 2: ${played} groups played, ${moved} after a move, none again`);
}

// level 1: a sprite added that causes a conflict (its value searched with the untouched groups), then moved: the
// search plays only the groups with the added sprite again
{
  const lv = loadLevel(rom, 0x1), m = lv.spriteHeader & 0x3f;
  const ctx = { emu, level: 0x1, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const groupResults = new Counted('001');
  const run = (sprites: LevelSprite[], kept: boolean) => checkAndSuggest(ctx, kept ? groupResults : undefined, m, sprites);
  run(lv.sprites, true);
  const e0 = { uid: newUid(), num: 0xe0, x: lv.sprites[0].x, y: lv.sprites[0].y + 2, extra: 0 };
  groupResults.ran = 0;
  const first = run([...lv.sprites, e0], true), firstRan = groupResults.ran;
  if (!first.check.conflicts.size || first.suggestion === null) fail(`001 with $E0: no conflicts (${first.check.conflicts.size}) or no suggestion`);
  const moved = [...lv.sprites, { ...e0, x: e0.x + 1 }];
  groupResults.ran = 0;
  const kept = run(moved, true);
  const withE0 = spriteGroups(moved).filter((g) => g.some((s) => s.uid === e0.uid)).length;
  if (groupResults.ran > withE0 * candidates.length) fail(`001: the search after the move played ${groupResults.ran} groups, ${withE0} with $E0`);
  if (!same(kept, run(moved, false))) fail('001: after the move kept groups give another result than a check of the whole level');
  else console.log(`001 $E0 added: ${firstRan} groups played; moved: ${groupResults.ran} (${withE0} groups with it), suggestion ${kept.suggestion?.toString(16)}`);
}

// what a check reads, as the learner records it (each step tracked, as Learner runs a job)
const jobReads = (ctx: SpriteMemContext, m: number, values: number[], sprites: LevelSprite[]) => {
  const job = spriteMemJob(ctx, m, values, sprites), reads = new RomReads(rom);
  for (;;) {
    const r = emu.tracked(() => job.next());
    reads.add(r.reads);
    if (r.result.done) return { result: r.result.value, reads };
  }
};
// group results each as if it read a page of its own (a page of the free space at the ROM's end, read by nothing
// else): a check's reads show which results it depends on
class Marked extends Counted {
  marks = new Map<string, number>(); // key: its page
  set(key: string, check: GroupResult['check'], reads: RomReads): void {
    const p = (rom.data.length >> PAGE_SHIFT) - 1 - this.marks.size;
    this.marks.set(key, p);
    reads.read(p << PAGE_SHIFT);
    rom.reads?.read(p << PAGE_SHIFT); // (read where the group is played)
    super.set(key, check, reads);
  }
  in(reads: RomReads): string { return [...this.marks.values()].filter((p) => reads.pages[p]).sort().join(); }
}

// a check depends on the bytes read for the current value and the chosen suggestion only, not those of values tried
// and rejected (#208): when it plays the groups and when it uses kept results; the values tried least used first
// (several fail before one fits)
{
  const lv = loadLevel(rom, 0xc);
  const ctx = { emu, level: 0xc, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const sprites: LevelSprite[] = [...lv.sprites, { uid: newUid(), num: 0xe0, x: 8, y: 0x14, extra: 0 }];
  const groups = spriteGroups(sprites), values = [...candidates].reverse(), groupResults = new Marked('00C reads');
  const played = jobReads({ ...ctx, groupResults }, 0, values, sprites), kept = jobReads({ ...ctx, groupResults }, 0, values, sprites);
  const s = played.result.suggestion;
  if (s === null) fail('00C reads: no suggestion');
  else {
    const tried = values.slice(0, values.indexOf(s)).filter((v) => v !== 0).length;
    if (!tried) fail('00C reads: no value rejected before the suggestion');
    // the results of the current value and the suggestion (all kept by now)
    const own = emu.tracked(() => checkSpriteMemory({ ...ctx, groupResults }, 0, groups)).reads;
    own.add(emu.tracked(() => checkSpriteMemory({ ...ctx, groupResults }, s, groups)).reads);
    const want = groupResults.in(own);
    if (!want) fail('00C reads: no group results marked');
    if (groupResults.in(played.reads) !== want) fail('00C reads: the check playing the groups depends on a rejected value');
    else if (groupResults.in(kept.reads) !== want) fail('00C reads: the check with kept groups depends on a rejected value');
    else console.log(`00C reads: ${want.split(',').length} of ${groupResults.marks.size} group results (current value and suggestion ${s.toString(16)}, ${tried} values rejected)`);
  }
}

// no value fits (only the values rejected above tried): the check depends on the bytes read for every value tried,
// so a ROM change that lets one fit checks again and finds a suggestion (#219); when it plays the groups and when it
// uses kept results
{
  const lv = loadLevel(rom, 0xc);
  const ctx = { emu, level: 0xc, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const sprites: LevelSprite[] = [...lv.sprites, { uid: newUid(), num: 0xe0, x: 8, y: 0x14, extra: 0 }];
  const all = [...candidates].reverse(), first = runJob(spriteMemJob(ctx, 0, all, sprites)).suggestion;
  const values = first === null ? [] : all.slice(0, all.indexOf(first)).filter((v) => v !== 0);
  const groupResults = new Marked('00C none fits');
  const played = jobReads({ ...ctx, groupResults }, 0, values, sprites), kept = jobReads({ ...ctx, groupResults }, 0, values, sprites);
  const want = [...groupResults.marks.values()].sort().join();
  if (!values.length || !want) fail(`00C none fits: ${values.length} values rejected, ${groupResults.marks.size} group results marked`);
  else if (played.result.suggestion !== null || kept.result.suggestion !== null) fail('00C none fits: a suggestion');
  else if (groupResults.in(played.reads) !== want) fail('00C none fits: the check playing the groups misses a rejected value\'s reads');
  else if (groupResults.in(kept.reads) !== want) fail('00C none fits: the check with kept groups misses a rejected value\'s reads');
  else console.log(`00C none fits: depends on all ${groupResults.marks.size} group results (${values.length} values rejected)`);
}

// two groups with the same layout in one level ($E0 twice, far apart) share a result: the check plays it once, with
// the same conflicts and suggestion as a check of the whole level
{
  const lv = loadLevel(rom, 0xc);
  const ctx = { emu, level: 0xc, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const sprites: LevelSprite[] = [{ uid: newUid(), num: 0xe0, x: 8, y: 0x14, extra: 0 }, { uid: newUid(), num: 0xe0, x: 0x48, y: 0x14, extra: 0 }];
  const groupResults = new Counted('00C same layout');
  const c = checkSpriteMemory({ ...ctx, groupResults }, 0, spriteGroups(sprites)), ran = groupResults.ran;
  const kept = checkAndSuggest(ctx, groupResults, 0, sprites), whole = checkAndSuggest(ctx, undefined, 0, sprites);
  if (c.live.length !== 2 || ran !== 1 || c.conflicts.size !== 2) fail(`00C same layout: ${c.live.length} groups, ${ran} played, ${c.conflicts.size} conflicts`);
  else if (!same(kept, whole)) fail('00C same layout: kept groups give another result than a check of the whole level');
  else console.log(`00C same layout: one group played for two, ${kept.check.conflicts.size} conflicts, suggestion ${kept.suggestion?.toString(16)} as a whole check`);
}

// levels with their own sprite memory
const list = process.argv[2] ? process.argv[2].split(',').map((x) => parseInt(x, 16)) : [0x5, 0x23, 0x135, 0x105, 0x106, 0x1, 0x2, 0x101, 0x103, 0x10b];
for (const n of list) {
  const lv = loadLevel(rom, n);
  const ctx = { emu, level: n, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const t0 = Date.now();
  const groups = spriteGroups(lv.sprites);
  const c = checkSpriteMemory(ctx, lv.spriteHeader & 0x3f, groups);
  const names = [...c.conflicts].map((u) => { const s = lv.sprites.find((q) => q.uid === u)!; return `${s.num.toString(16)}@${s.x},${s.y}`; });
  console.log(`${n.toString(16).padStart(3, '0')} mem=${(lv.spriteHeader & 0x3f).toString(16)} sprites=${lv.sprites.length} groups=${groups.length} ${Date.now() - t0}ms conflicts=${names.join(' ') || '-'}`);
  if (c.conflicts.size) fail(`${n.toString(16)}: conflicts with its own sprite memory`);
}
console.log('bad', bad);
if (bad) process.exitCode = 1;
