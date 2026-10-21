// Learning emulated results on the main thread (learner.ts): a result the cache holds comes back without
// running anything; two requests for one key run its job once; a sliced job during which the ROM bytes it
// read change keeps nothing and is learned again.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { ResultLearner } from '../src/core/learner.ts';
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

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
