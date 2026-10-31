// The job runner (jobrunner.ts) under the result learner on both threads, checked by testlearner and testprobehost:
// a job runs a step at a time and its result is stored with its input and the bytes it read; a job whose read bytes
// change between two steps starts over before its next one, one whose read bytes don't change keeps running; a
// prepared state is reused on the lane's emulator while the bytes preparing it read are unchanged, and its reads count
// for every job using it; pictures start from the main boot snapshot, other results from one without the display data.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { ResultCache, RomFingerprint, type RomReads } from '../src/core/romdeps.ts';
import { JobRunner, type JobRun } from '../src/core/jobrunner.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { FG_PALS } from '../src/core/sharedpal.ts';
import { editorImage } from './fixture.ts';

export async function checkJobRunner(check: (ok: boolean, what: string) => void): Promise<void> {
  const rom = new Rom(await editorImage());
  const main = new LevelEmulator(rom);
  main.skipMask = () => gfxSkipMask(rom); // as the editor
  main.boot();
  const results = new ResultCache(new RomFingerprint(rom)), runner = new JobRunner({ rom, results, main });
  const spare = rom.allocWrite(new Uint8Array(0x300)); // a page of its own no load reads
  const toEnd = <T>(r: JobRun<T>) => { for (;;) { const d = runner.step('lane', r); if (d) return d.result; } };

  // a job reading the spare page: one step per byte, its sum as the result
  let steps = 0;
  function* sum(n: number): Generator<void, number> {
    let s = 0;
    for (let i = 0; i < n; i++) { steps++; s += rom.r8(spare + i); yield; }
    return s;
  }
  const job = (key: string, input?: string) => runner.run({ key, input, keep: true, picture: false, start: () => sum(4) });

  // step, store with input
  const a = job('a', 'in');
  check(runner.step('lane', a) === null && steps === 1, 'runner: a step at a time');
  check(toEnd(a) === 0 && steps === 4, 'runner: runs to its end');
  const e = results.entry('a', 'in');
  check(e?.input === 'in' && results.get('a') === undefined && results.get('a', 'in') === 0, 'runner: stored under its key with its input');
  const fp = new RomFingerprint(rom), started = runner.started;
  check(!!e && fp.valid(e.deps) && toEnd(job('a', 'in')) === 0 && runner.started === started, 'runner: the stored result, not run again');

  // restart: a byte it read changed between two steps; a byte elsewhere keeps it running
  const b = job('b');
  runner.step('lane', b); runner.step('lane', b);
  rom.w8(spare + 0x200, 9);
  runner.step('lane', b);
  check(runner.started === started + 1, 'runner: a write elsewhere keeps the job running');
  rom.w8(spare, 5);
  runner.step('lane', b);
  check(runner.started === started + 2, 'runner: a read byte changed between two steps: started over before the next one');
  check(toEnd(b) === 5 && results.get('b') === 5, 'runner: the result of the new bytes kept');
  rom.w8(spare, 0); rom.w8(spare + 0x200, 0);

  // prepared state: reused while what preparing it read is unchanged, its reads counted for every job using it
  let prepared = 0;
  const using = (key: string) => runner.run({
    key, keep: true, picture: false,
    start: (emu, prepare) => (function* () { yield; return prepare('p', () => { prepared++; return rom.r8(spare + 0x100) + 1; }); })(),
  });
  const reads = (r: JobRun<unknown>): RomReads => { toEnd(r); return r.reads; };
  const at = snesToPc(spare + 0x100), spareRead = (r: RomReads) => !!r.pages[at >> 8] || r.bytes.has(at);
  const first = reads(using('u1')), second = reads(using('u2'));
  check(prepared === 1, `runner: a prepared state is reused by the next job on the lane (${prepared} preparations)`);
  check(spareRead(first) && spareRead(second), 'runner: its reads count for every job using it');
  rom.w8(spare + 0x100, 7);
  check(toEnd(using('u3')) === 8 && prepared === 2, 'runner: a byte preparing it read changed: prepared again');
  rom.w8(spare + 0x100, 0);

  // picture vs no picture: from the main boot snapshot, or from one without the display data (the shared colors)
  const pic = runner.emu('pic', true), plain = runner.emu('plain', false), pal = snesToPc(FG_PALS);
  const has = (r: RomReads | null) => !!r && (!!r.pages[pal >> 8] || r.bytes.has(pal));
  check(pic.baseState === main.baseState && has(pic.bootReads), 'runner: a picture starts from the main boot snapshot, which read the colors');
  check(!!plain.baseState && plain.baseState !== main.baseState && !has(plain.bootReads), 'runner: a result that is no picture starts from a boot snapshot without them');
}
