// Learning emulated results on the main thread (learner.ts): a result the cache holds comes back without
// running anything; two requests for one key run its job once; a sliced job during which the ROM bytes it
// read change keeps nothing and is learned again. A result with an input (inputs.ts) is learned again when
// the input or a byte it read changes, and reused when neither does; one kept in memory isn't stored.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { ResultLearner } from '../src/core/learner.ts';
import { inputHash, levelInput } from '../src/core/inputs.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

const rom = new Rom(await editorImage());
const main = new LevelEmulator(rom); main.boot();
const spare = rom.allocWrite(new Uint8Array(0x300)); // a page of its own no load reads

function editor() {
  const results = new ResultCache(new RomFingerprint(rom));
  const steps: (() => void)[] = [];
  const learner = new ResultLearner({
    rom, results, cacheReady: Promise.resolve(), main,
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
  const stored = results.flush().put.map(([k]) => k);
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

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
