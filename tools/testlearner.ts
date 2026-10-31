// Learning emulated results on the main thread (learner.ts): a result the cache holds comes back without
// running anything; two requests for one key run its job once; a sliced job during which the ROM bytes it
// read change keeps nothing and is learned again (it starts over before its next step). A result with an input
// (inputs.ts) is learned again when the input or a byte it read changes, and reused when neither does; one kept in
// memory isn't stored.
// Memory-only results (#200): a write looks at a key's inputs only, not at all results (counted); a key keeps its latest
// used inputs, the latest used results stay within the limit, and a round keeps all results it used, also more.
// A result that is no picture doesn't read what blocks look like (ADR 0008): flipping a standard Map16 tile's
// quarters or changing a shared color keeps the levels' uses, sprite images and object thumbnails are learned again.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ResultCache, RomFingerprint, INPUTS_PER_KEY } from '../src/core/romdeps.ts';
import { ResultLearner } from '../src/core/learner.ts';
import { MemoryResults } from '../src/core/jobrunner.ts';
import { inputHash, levelInput } from '../src/core/inputs.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { LevelUses, usedLevels } from '../src/core/levelusage.ts';
import { loadLevel, levelRows } from '../src/core/level.ts';
import { renderLevel, setFgWords, map16Source } from '../src/core/render.ts';
import { setSharedColor, sharedColor } from '../src/core/sharedpal.ts';
import { captureSprites } from '../src/core/spritegfx.ts';
import { objectThumbsJob, objKey } from '../src/core/objthumbs.ts';
import { editorImage } from './fixture.ts';
import { checkJobRunner } from './runnercheck.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

const rom = new Rom(await editorImage());
const main = new LevelEmulator(rom); main.boot();
const spare = rom.allocWrite(new Uint8Array(0x300)); // a page of its own no load reads

function editor(r = rom, m = main) {
  const results = new ResultCache(new RomFingerprint(r));
  const steps: (() => void)[] = [];
  const learner = new ResultLearner({
    rom: r, results, cacheReady: Promise.resolve(), main: m,
    later: (_key, step) => steps.push(step), soon: (step) => steps.push(step),
    setBusy: () => {},
  });
  // runs the background slices until none is left (stored results are awaited first)
  const drain = async () => { for (let i = 0; i < 100; i++) { await new Promise((r) => setTimeout(r, 0)); while (steps.length) steps.shift()!(); } };
  return { results, learner, drain };
}

// a job reading the spare page: one step per byte (a slice each), its sum as the result
let runs = 0;
function* sum(n: number): Generator<void, number> {
  runs++;
  let s = 0;
  for (let i = 0; i < n; i++) { s += rom.r8(spare + i); yield; }
  return s;
}

// a cached result: returned without running, at once and sliced
{
  const { results, learner } = editor();
  results.set('k', 42, results.fp.deps(main.tracked(() => rom.r8(spare)).reads));
  runs = 0;
  check(learner.now('k', (emu) => emu.tracked(() => { runs++; return 7; })) === 42 && runs === 0, 'a cached result comes back at once without running');
  check(learner.learn('k', () => sum(3)) === 42 && runs === 0, 'and sliced');
}

// learned at once: stored, the next request doesn't run it again
{
  const { learner } = editor();
  runs = 0;
  const run = (emu: LevelEmulator) => emu.tracked(() => { runs++; return rom.r8(spare) + 1; });
  const a = learner.now('n', run), b = learner.now('n', run);
  check(a === 1 && b === 1 && runs === 1, 'a result learned at once is kept');
}

// two requests for one key while its sliced job runs: it runs once, both hear of the result
{
  const { results, learner, drain } = editor();
  runs = 0;
  const heard: number[] = [];
  const first = learner.learn('s', () => sum(4), { done: (r) => heard.push(r) });
  const second = learner.learn('s', () => sum(4), { done: (r) => heard.push(r + 100) });
  await drain();
  check(first === undefined && second === undefined, 'undefined while it is learned');
  check(runs === 1 && heard.join() === '0,100', `two requests for one key run once, both called (${runs} runs, ${heard})`);
  check(results.get('s') === 0 && learner.learn('s', () => sum(4)) === 0 && runs === 1, 'the result is kept');
}

// the same callback asked twice for a key in flight: called once
{
  const { learner, drain } = editor();
  let once = 0;
  const f = () => once++;
  learner.learn('t', () => sum(2), { done: f });
  learner.learn('t', () => sum(2), { done: f });
  await drain();
  check(once === 1, 'the same callback asked twice is called once');
}

// a ROM write to bytes the job read, while it runs: nothing kept from that run, learned again with the new bytes
{
  const { results, learner, drain } = editor();
  runs = 0;
  const heard: number[] = [];
  let wrote = false;
  learner.learn('w', function* () {
    const s = yield* sum(4);
    if (!wrote) { wrote = true; rom.w8(spare, 5); } // (after its last read)
    return s;
  }, { done: (r) => heard.push(r) });
  await drain();
  check(runs === 2 && heard.join() === '5', `learned again after a ROM write (${runs} runs, ${heard})`);
  check(results.get('w') === 5, 'only the result from the new bytes is kept');
  rom.w8(spare, 0);
}

// a ROM write to a byte the job read, between two of its steps: it starts over before its next step
{
  const { results, learner, drain } = editor();
  runs = 0;
  let wrote = false, third = 0;
  learner.learn('v', function* () {
    runs++;
    const s = rom.r8(spare);
    yield;
    if (!wrote) { wrote = true; rom.w8(spare, 3); }
    yield;
    third++;
    return s;
  });
  await drain();
  check(runs === 2 && third === 1 && results.get('v') === 3, `started over before the step after the write (${runs} runs, ${third} third steps)`);
  rom.w8(spare, 0);
}

// a ROM write to bytes the job didn't read: kept
{
  const { results, learner, drain } = editor();
  runs = 0;
  let wrote = false;
  learner.learn('u', function* () {
    const s = yield* sum(4);
    if (!wrote) { wrote = true; rom.w8(spare + 0x200, 9); }
    return s;
  });
  await drain();
  check(runs === 1 && results.get('u') === 0, 'a write elsewhere keeps the result');
  rom.w8(spare + 0x200, 0);
}

// inputs: hashed canonically (not by identity or key order), the level as edited without what only records a load
{
  const a = { x: 1, s: new Set([1, 2]), m: new Map([[1, 'a']]), b: Uint8Array.of(1, 2) };
  const b = { b: Uint8Array.of(1, 2), m: new Map([[1, 'a']]), s: new Set([2, 1]), x: 1, f: () => 0, u: undefined };
  check(inputHash(a) === inputHash(b), 'equal inputs hash alike');
  check(inputHash({ ...a, x: 2 }) !== inputHash(a) && inputHash({ ...a, b: Uint8Array.of(1, 3) }) !== inputHash(a)
    && inputHash({ ...a, s: new Set([1]) }) !== inputHash(a) && inputHash([1, 2]) !== inputHash([2, 1]), 'a changed field changes the hash');
  const ov = { layer1: Uint8Array.of(1, 2, 3), sprites: Uint8Array.of(0, 0xff) };
  check(inputHash(levelInput(0x105, { ...ov, byteOwner: new Int32Array(4) })) === inputHash(levelInput(0x105, ov)), 'the level input leaves out what records a load');
  check(inputHash(levelInput(0x105, { ...ov, switchPalaces: true })) !== inputHash(levelInput(0x105, ov))
    && inputHash(levelInput(0x106, ov)) !== inputHash(levelInput(0x105, ov)), 'a view setting or another level changes it');
}

// a result with an input, learned at once and sliced: reused for the same input, learned again for another one
// or when a byte it read changed
for (const keep of [true, 'memory'] as const) {
  const { results, learner, drain } = editor();
  const what = keep === true ? 'stored' : 'kept in memory';
  runs = 0;
  const run = (emu: LevelEmulator) => emu.tracked(() => { runs++; return rom.r8(spare) + 1; });
  learner.now('i', run, { input: { a: 1 }, keep });
  learner.now('i', run, { input: { a: 1 }, keep });
  check(runs === 1, `${what}: the same input reuses the result (${runs} runs)`);
  learner.now('i', run, { input: { a: 2 }, keep });
  check(runs === 2, `${what}: another input learns it again`);
  rom.w8(spare, 4);
  check(learner.now('i', run, { input: { a: 2 }, keep }) === 5 && runs === 3, `${what}: a changed byte it read learns it again`);
  rom.w8(spare, 0);
  runs = 0;
  const heard: number[] = [];
  learner.learn('j', () => sum(2), { input: 'x', keep, done: (r) => heard.push(r) });
  await drain();
  check(learner.learn('j', () => sum(2), { input: 'x', keep }) === 0 && runs === 1, `${what}, sliced: the same input reuses it`);
  check(learner.learn('j', () => sum(2), { input: 'y', keep }) === undefined, `${what}, sliced: another input learns it again`);
  await drain();
  check(runs === 2 && learner.learn('j', () => sum(2), { input: 'y', keep }) === 0, `${what}, sliced: learned for the new input`);
  const stored = results.flush().put.map(([k]) => k.split('#')[0]); // (stored by key and input)
  check(keep === true ? stored.includes('i') && stored.includes('j') : !stored.length, `${what}: ${keep === true ? 'in' : 'not in'} the result cache (${stored})`);
}

// two inputs asked for in one lane with replace: only the latest is learned
{
  const { learner, drain } = editor();
  runs = 0;
  const heard: string[] = [];
  learner.learn('r', () => sum(3), { input: 1, keep: 'memory', lane: 'l', replace: true, done: () => heard.push('1') });
  learner.learn('r', () => sum(3), { input: 2, keep: 'memory', lane: 'l', replace: true, done: () => heard.push('2') });
  await drain();
  check(heard.join() === '2', `replace drops the request for another input (${heard})`);
}

// Display data (ADR 0008): the levels' uses (picture: false) and, to compare, the same as pictures, each in an editor of
// its own; sprite images and object thumbnails of level 105 as pictures
{
  const r = new Rom(await editorImage());
  const m = new LevelEmulator(r);
  m.skipMask = () => gfxSkipMask(r); // as the editor
  m.boot();
  const levels = [0x105, ...usedLevels(r).slice(0, 12)];
  const scanned = async (picture: boolean) => {
    const e = editor(r, m), uses = new LevelUses(r, e.results);
    let done = false;
    e.learner.learn('uses', function* (emu) { for (const n of levels) { uses.scan(n, emu); yield; } }, { keep: false, picture, done: () => (done = true) });
    while (!done) await e.drain();
    return uses;
  };
  const plain = await scanned(false), shown = await scanned(true);
  const { learner, results, drain } = editor(r, m);
  const lv = loadLevel(r, 0x105), bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
  const sprites = () => learner.now('spr', (emu) => emu.tracked(() => captureSprites(emu, 0x105, lv.header, lv.spriteHeader, bg, [0, 1, 2, 3, 4, 5])));
  sprites();
  const specs = [...new Map(lv.objects.map((o) => [`${o.num}:${o.ext}:${o.size}`, { num: o.num, ext: o.ext, size: o.size }])).values()];
  const keyOf = (q: typeof specs[number]) => objKey(q, null);
  const thumbs = () => learner.learn('thumbs', (emu) => objectThumbsJob(r, emu, lv, specs, keyOf));
  thumbs();
  await drain();
  check(plain.missing(levels).length === 0 && shown.missing(levels).length === 0 && results.get('spr') !== undefined
    && !!thumbs()?.some((t) => t.m16.includes(0x130)), 'display data: uses, sprite images and object thumbnails (one showing tile 130) learned');

  // the open level as drawn (App.refresh): every byte its load and the boot read
  const draw = () => { const x = m.load(0x105); renderLevel(r, x, lv.header.mode, lv.header.screens, levelRows(lv.secondary)); };
  const drawn = () => { const gen = r.gen; return () => m.recordAll(draw).reads.touches(r.changesSince(gen)!); };
  let redrawn = drawn();
  setFgWords(r, m.load(0x105), 0x130, [...map16Source(r, m.load(0x105)).fg(0x130)].map((w) => w ^ 0x4000));
  const flipped = shown.missing(levels).length;
  check(plain.missing(levels).length === 0 && flipped > 0, `flipping tile 130's quarters keeps every level's uses (as pictures ${flipped} of ${levels.length} would be learned again)`);
  check(thumbs() === undefined && redrawn(), 'the object thumbnails are learned again, the open level drawn anew');
  await drain();
  for (const n of shown.missing(levels)) shown.scan(n, learner.emu());
  sprites();
  redrawn = drawn();

  setSharedColor(r, 0x21, sharedColor(r, 0x21) ^ 1);
  check(plain.missing(levels).length === 0 && shown.missing(levels).length === levels.length,
    'changing a shared color keeps every level\'s uses (as pictures all would be learned again)');
  check(results.get('spr') === undefined && thumbs() === undefined && redrawn(), 'the sprite images and object thumbnails are learned again, the open level drawn anew');
}

// memory-only results: writes look at a key's inputs only; the bounds; a round keeps what it used
{
  const fp = new RomFingerprint(rom), deps = fp.deps(main.tracked(() => rom.r8(spare)).reads);
  const mem = new MemoryResults(fp, 256);
  for (let i = 0; i < 20000; i++) mem.set(`k${i % 5000}`, i, deps, `${i}`);
  check(mem.looked <= 20000 * 2 * (INPUTS_PER_KEY + 1), `20000 writes look at ${mem.looked} entries (not all results each)`);
  check(mem.get('k4999', '19999') === 19999 && mem.get('k0', '0') === undefined, 'the latest used results stay within the limit');
  const one = new MemoryResults(fp, 256);
  for (let i = 0; i < 10; i++) one.set('k', i, deps, `${i}`);
  check(one.get('k', '9') === 9 && one.get('k', `${9 - INPUTS_PER_KEY + 1}`) !== undefined && one.get('k', `${9 - INPUTS_PER_KEY}`) === undefined,
    `a key keeps its latest used ${INPUTS_PER_KEY} inputs`);
  const round = new MemoryResults(fp, 16);
  round.startRound();
  for (let i = 0; i < 1000; i++) round.set(`r${i}`, i, deps, undefined);
  round.endRound();
  // the next rounds (one left unfinished) write new results before they read the kept ones
  for (const end of [false, true]) {
    round.startRound();
    for (let i = 0; i < 50; i++) round.set(`n${end}${i}`, i, deps, undefined);
    let kept = 0;
    for (let i = 0; i < 1000; i++) if (round.get(`r${i}`, undefined) === i) kept++;
    if (end) round.endRound();
    check(kept === 1000, `a round of 1000 results with a limit of 16: the next ${end ? '' : 'unfinished '}round writing 50 first finds ${kept}`);
  }
  round.startRound();
  for (let i = 0; i < 20; i++) round.set(`s${i}`, i, deps, undefined);
  round.endRound();
  round.startRound();
  for (let i = 0; i < 20; i++) round.set(`t${i}`, i, deps, undefined);
  round.endRound();
  check(round.get('r999', undefined) === undefined && round.get('s0', undefined) === 0 && round.get('t19', undefined) === 19,
    'smaller rounds drop the results of earlier rounds');
}

// the job runner under both owners (runnercheck.ts)
await checkJobRunner(check);

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
