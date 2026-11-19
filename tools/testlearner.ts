// Learning emulated results on the main thread (learner.ts) at once, and jobs a step at a time on the job runner under
// it (jobrunner.ts, as the probe worker's lanes run them): a result the cache holds comes back without running
// anything; a job during which the ROM bytes it read change keeps nothing and is learned again (it starts over before
// its next step). A result with an input (inputs.ts) is learned again when the input or a byte it read changes, and
// reused when neither does; one kept in memory isn't stored.
// Memory-only results (#200): a write looks at a key's inputs only, not at all results (counted); a key keeps its latest
// used inputs, the latest used results stay within the limit, and a round keeps all results it used, also more.
// A result that is no picture doesn't read what blocks look like (ADR 0008): flipping a standard Map16 tile's
// quarters or changing a shared color keeps the levels' uses, sprite images and object thumbnails are learned again.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { INPUTS_PER_KEY } from '../src/core/keptresults.ts';
import { ResultLearner } from '../src/core/learner.ts';
import { memoryResults, MEMORY_CONTENTS, JobRunner, type Job, type Keep } from '../src/core/jobrunner.ts';
import { inputHash, levelInput } from '../src/core/inputs.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { LevelUses, usedLevels } from '../src/core/levelusage.ts';
import { loadLevel, levelRows } from '../src/core/level.ts';
import { renderLevel, setFgWords, map16Source } from '../src/core/render.ts';
import { setSharedColor, sharedColor } from '../src/core/sharedpal.ts';
import { captureSprites } from '../src/core/spritegfx.ts';
import { objectThumbsJob, objKey } from '../src/core/objthumbs.ts';
import { editorImage } from './fixture.ts';
import { checkJobRunner, learnAtOnce } from './runnercheck.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

const rom = new Rom(await editorImage());
const main = new LevelEmulator(rom); main.boot();
const spare = rom.allocWrite(new Uint8Array(0x300)); // a page of its own no load reads

function editor(r = rom, m = main) {
  const results = new ResultCache(new RomFingerprint(r));
  const learner = new ResultLearner({ rom: r, results, main: m }), runner = new JobRunner({ rom: r, results, main: m });
  // a job learned a step at a time to its end (stored as keep says; input: hashed)
  const learn = <T>(key: string, start: (emu: LevelEmulator) => Job<T>, opts: { input?: unknown; keep?: Keep; picture?: boolean } = {}): T =>
    learnAtOnce(runner, { key, input: opts.input === undefined ? undefined : inputHash(opts.input), keep: opts.keep ?? true, picture: opts.picture ?? true, start });
  return { results, learner, runner, learn };
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
  const { results, learner, learn } = editor();
  results.set('k', 42, results.fp.deps(main.record('picture', () => rom.r8(spare)).reads));
  runs = 0;
  check(learner.now('k', (emu) => emu.record('picture', () => { runs++; return 7; })) === 42 && runs === 0, 'a cached result comes back at once without running');
  check(learn('k', () => sum(3)) === 42 && runs === 0, 'and a step at a time');
}

// learned at once: stored, the next request doesn't run it again
{
  const { learner } = editor();
  runs = 0;
  const run = (emu: LevelEmulator) => emu.record('picture', () => { runs++; return rom.r8(spare) + 1; });
  const a = learner.now('n', run), b = learner.now('n', run);
  check(a === 1 && b === 1 && runs === 1, 'a result learned at once is kept');
}

// a job learned a step at a time: stored, the next request doesn't run it again
{
  const { results, learn } = editor();
  runs = 0;
  check(learn('s', () => sum(4)) === 0 && runs === 1 && results.get('s') === 0 && learn('s', () => sum(4)) === 0 && runs === 1, 'a job\'s result is kept');
}

// a ROM write to bytes the job read, while it runs: nothing kept from that run, learned again with the new bytes
{
  const { results, learn } = editor();
  runs = 0;
  let wrote = false;
  const heard = learn('w', function* () {
    const s = yield* sum(4);
    if (!wrote) { wrote = true; rom.w8(spare, 5); } // (after its last read)
    return s;
  });
  check(runs === 2 && heard === 5, `learned again after a ROM write (${runs} runs, ${heard})`);
  check(results.get('w') === 5, 'only the result from the new bytes is kept');
  rom.w8(spare, 0);
}

// a ROM write to a byte the job read, between two of its steps: it starts over before its next step
{
  const { results, learn } = editor();
  runs = 0;
  let wrote = false, third = 0;
  learn('v', function* () {
    runs++;
    const s = rom.r8(spare);
    yield;
    if (!wrote) { wrote = true; rom.w8(spare, 3); }
    yield;
    third++;
    return s;
  });
  check(runs === 2 && third === 1 && results.get('v') === 3, `started over before the step after the write (${runs} runs, ${third} third steps)`);
  rom.w8(spare, 0);
}

// a ROM write to bytes the job didn't read: kept
{
  const { results, learn } = editor();
  runs = 0;
  let wrote = false;
  learn('u', function* () {
    const s = yield* sum(4);
    if (!wrote) { wrote = true; rom.w8(spare + 0x200, 9); }
    return s;
  });
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

// a result with an input, learned at once and a step at a time: reused for the same input, learned again for another one
// or when a byte it read changed
for (const keep of [true, 'memory'] as const) {
  const { results, learner, runner, learn } = editor();
  const what = keep === true ? 'stored' : 'kept in memory';
  runs = 0;
  const run = (emu: LevelEmulator) => emu.record('picture', () => { runs++; return rom.r8(spare) + 1; });
  learner.now('i', run, { input: { a: 1 }, keep });
  learner.now('i', run, { input: { a: 1 }, keep });
  check(runs === 1, `${what}: the same input reuses the result (${runs} runs)`);
  learner.now('i', run, { input: { a: 2 }, keep });
  check(runs === 2, `${what}: another input learns it again`);
  rom.w8(spare, 4);
  check(learner.now('i', run, { input: { a: 2 }, keep }) === 5 && runs === 3, `${what}: a changed byte it read learns it again`);
  rom.w8(spare, 0);
  runs = 0;
  learn('j', () => sum(2), { input: 'x', keep });
  check(learn('j', () => sum(2), { input: 'x', keep }) === 0 && runs === 1, `${what}, a step at a time: the same input reuses it`);
  check(runner.stored('j', inputHash('y'), keep) === undefined && learn('j', () => sum(2), { input: 'y', keep }) === 0 && runs === 2,
    `${what}, a step at a time: another input learns it again`);
  const stored = results.flush().put.map(([k]) => k.split('#')[0]); // (stored by key and input)
  check(keep === true ? stored.includes('i') && stored.includes('j') : !stored.length, `${what}: ${keep === true ? 'in' : 'not in'} the result cache (${stored})`);
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
    e.learn('uses', function* (emu) { for (const n of levels) { uses.scan(n, emu); yield; } }, { keep: false, picture });
    return uses;
  };
  const plain = await scanned(false), shown = await scanned(true);
  const { learner, results, runner, learn } = editor(r, m);
  const lv = loadLevel(r, 0x105), bg = lv.layer2Pointer >> 16 === 0xff ? lv.layer2Pointer : 0xffd900;
  const sprites = () => learner.now('spr', (emu) => emu.record('picture', () => captureSprites(emu, { number: 0x105, header: lv.header, spriteHeader: lv.spriteHeader, bgPointer: bg }, [0, 1, 2, 3, 4, 5])));
  sprites();
  const specs = [...new Map(lv.objects.map((o) => [`${o.num}:${o.ext}:${o.size}`, { num: o.num, ext: o.ext, size: o.size }])).values()];
  const keyOf = (q: typeof specs[number]) => objKey(q, null);
  const thumbs = () => learn('thumbs', (emu) => objectThumbsJob(r, emu, lv, specs, keyOf));
  const thumbsKept = () => runner.stored('thumbs', undefined, true) !== undefined;
  check(plain.missing(levels).length === 0 && shown.missing(levels).length === 0 && results.get('spr') !== undefined
    && !!thumbs()?.some((t) => t.m16.includes(0x130)), 'display data: uses, sprite images and object thumbnails (one showing tile 130) learned');

  // the open level as drawn (App.refresh): every byte its load and the boot read
  const draw = () => { const x = m.load(0x105); renderLevel(r, x, lv.header.mode, lv.header.screens, levelRows(lv.secondary)); };
  const drawn = () => { const gen = r.gen; return () => m.record('title screen', draw).reads.touches(r.changesSince(gen)!); };
  let redrawn = drawn();
  setFgWords(r, m.load(0x105), 0x130, [...map16Source(r, m.load(0x105)).fg(0x130)].map((w) => w ^ 0x4000));
  const flipped = shown.missing(levels).length;
  check(plain.missing(levels).length === 0 && flipped > 0, `flipping tile 130's quarters keeps every level's uses (as pictures ${flipped} of ${levels.length} would be learned again)`);
  check(!thumbsKept() && redrawn(), 'the object thumbnails are learned again, the open level drawn anew');
  thumbs();
  for (const n of shown.missing(levels)) shown.scan(n, learner.emu());
  sprites();
  redrawn = drawn();

  setSharedColor(r, 0x21, sharedColor(r, 0x21) ^ 1);
  check(plain.missing(levels).length === 0 && shown.missing(levels).length === levels.length,
    'changing a shared color keeps every level\'s uses (as pictures all would be learned again)');
  check(results.get('spr') === undefined && !thumbsKept() && redrawn(), 'the sprite images and object thumbnails are learned again, the open level drawn anew');
}

// memory-only results: the bounds (keys, not inputs, counted for the limit); a round keeps what it used
{
  const fp = new RomFingerprint(rom), deps = fp.deps(main.record('picture', () => rom.r8(spare)).reads);
  const mem = memoryResults(fp, 256);
  for (let i = 0; i < 20000; i++) mem.set(`k${i % 5000}`, i, deps, `${i}`);
  check(mem.get('k4999', '19999') === 19999 && mem.get('k0', '0') === undefined, 'the latest used results stay within the limit');
  const wide = memoryResults(fp, 16);
  for (let k = 0; k < 16; k++) for (let i = 0; i < INPUTS_PER_KEY; i++) wide.set(`w${k}`, i, deps, `${i}`);
  let all = 0;
  for (let k = 0; k < 16; k++) for (let i = 0; i < INPUTS_PER_KEY; i++) if (wide.get(`w${k}`, `${i}`) === i) all++;
  check(all === 16 * INPUTS_PER_KEY, `a limit of 16 keeps 16 keys with ${INPUTS_PER_KEY} inputs each (${all} results)`);
  wide.set('w16', 0, deps, '0');
  check(wide.get('w0', '0') === undefined && wide.get('w1', '0') === 0 && wide.get('w16', '0') === 0, 'one key more drops the least recently used key');
  const one = memoryResults(fp, 256);
  for (let i = 0; i < 10; i++) one.set('k', i, deps, `${i}`);
  check(one.get('k', '9') === 9 && one.get('k', `${9 - INPUTS_PER_KEY + 1}`) !== undefined && one.get('k', `${9 - INPUTS_PER_KEY}`) === undefined,
    `a key keeps its latest used ${INPUTS_PER_KEY} inputs`);
  // the results of an input on the latest MEMORY_CONTENTS ROM states (#386): an undo and a redo find theirs
  {
    const was = rom.r8(spare), at = (v: number) => { rom.w8(spare, v); return fp.deps(main.record('picture', () => rom.r8(spare)).reads); };
    const states = memoryResults(fp, 256);
    states.set('u', 'A', at(was ^ 1), 'i');
    states.set('u', 'B0', at(was ^ 2), 'i');
    states.set('u', 'B', at(was ^ 2), 'i'); // (the same ROM state again: replaces B0, A stays)
    for (let k = 1; k < INPUTS_PER_KEY; k++) states.set('u', `other${k}`, deps, `${k}`);
    const a = (at(was ^ 1), states.get('u', 'i')), b = (at(was ^ 2), states.get('u', 'i'));
    const none = (at(was ^ 3), states.get('u', 'i'));
    states.set('u', 'C', fp.deps(main.record('picture', () => rom.r8(spare)).reads), 'i');
    const pushed = (at(was ^ 1), states.get('u', 'i')), kept = (at(was ^ 2), states.get('u', 'i'));
    rom.w8(spare, was); // (the other inputs' results: made on it)
    let others = 0;
    for (let k = 1; k < INPUTS_PER_KEY; k++) if (states.get('u', `${k}`) === `other${k}`) others++;
    check(MEMORY_CONTENTS === 2 && a === 'A' && b === 'B' && none === undefined, 'a result per ROM state of an input (set again on one: replaced): undone and redone, each found; none on a third');
    check(pushed === undefined && kept === 'B' && others === INPUTS_PER_KEY - 1, `a third state's result pushes out the oldest; the key keeps its ${INPUTS_PER_KEY} inputs`);
  }
  const round = memoryResults(fp, 16);
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
