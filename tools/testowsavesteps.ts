// The saves at every event progress learned a step per event (#385, owprogress.ts progressSavesJob,
// OverworldLoads.deriveSteps): all at once they held the probe worker for about 11 s. The steps give the saves
// progressSaves gives, also with other overworld jobs using the loads' emulator between them; two jobs asking for the
// saves share the steps; a ROM edit between steps that changes what they read starts them over, the saves as on the
// edited ROM.
// node tools/testowsavesteps.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, OW_EVENTS, readL1, writeL1 } from '../src/core/overworld.ts';
import { progressSaves, progressFlagsJob, progressSaveJob, type ProgressSave } from '../src/core/owprogress.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const json = (x: unknown) => JSON.stringify(x);
const loadsOf = (rom: Rom) => new OverworldLoads(new OverworldEmulator(rom), 4);
const STEP_MS = 400; // (the issue's 250 ms, measured in the probe host; slack for a busy machine)

const img = await editorImage();
const rom = new Rom(img.slice());
const saves = progressSaves(loadsOf(rom));

// ---- a step per event, other jobs on the emulator between them ----
{
  const loads = loadsOf(rom);
  const a = progressFlagsJob(loads), b = progressSaveJob(loads, OW_EVENTS);
  let steps = 0, longest = 0, ra: number[][] | undefined, rb: ProgressSave | undefined, bSteps = 0;
  for (;;) {
    const t0 = performance.now(), r = a.next(), dt = performance.now() - t0;
    longest = Math.max(longest, dt);
    if (dt > 120) console.log(`   step ${steps}: ${dt.toFixed(0)} ms`);
    if (r.done) { ra = r.value as number[][]; break; }
    steps++;
    // another job between the steps: a load, the console set as after another (its frames run on)
    loads.get(1, (steps * 7) % OW_EVENTS);
    loads.restore(0, steps % 5);
    loads.emu.snes.runFrame();
    // the second job asking for the saves goes on with the same steps
    if (steps % 3 === 0 && !rb) { const s = b.next(); bSteps++; if (s.done) rb = s.value as ProgressSave; }
  }
  while (!rb) { const s = b.next(); bSteps++; if (s.done) rb = s.value as ProgressSave; }
  console.log(`   ${steps} steps, the longest ${longest.toFixed(0)} ms`);
  check(steps > 40, `the saves learned in many steps (${steps})`);
  check(longest < STEP_MS, `each step under ${STEP_MS} ms (longest ${longest.toFixed(0)} ms)`);
  check(json(ra) === json(saves.map((s) => s.levelFlags)), 'the level flags at every progress as progressSaves gives them, with other jobs between the steps');
  check(json(rb) === json(saves[OW_EVENTS]), 'the second job: the save at the last progress as progressSaves gives it');
  check(bSteps <= Math.ceil(steps / 3) + 2, `the second job shared the steps (${bSteps} of its own)`);
  const t0 = performance.now(), again = progressFlagsJob(loads).next();
  check(again.done === true && performance.now() - t0 < 50, 'asked again: kept, one step');
}

// ---- a ROM edit between the steps ----
{
  const r = new Rom(img.slice()), loads = loadsOf(r), kinds = pathKinds(r), l1 = readL1(r);
  // (a layer 1 tile Mario doesn't walk on, as an overworld edit paints: the saves read layer 1)
  let cell = -1;
  for (let i = 0; i < 0x400; i++) if (kinds[l1[i]] === 'none' && l1[i] !== l1[i + 1]) { cell = i; break; }
  const job = progressFlagsJob(loads);
  for (let i = 0; i < 20; i++) job.next();
  const d = l1.slice(); d[cell] = l1[cell + 1];
  writeL1(r, d);
  let res: number[][] | undefined;
  for (;;) { const s = job.next(); if (s.done) { res = s.value as number[][]; break; } }
  const fresh = progressSaves(loadsOf(new Rom(r.data.slice())));
  check(json(res) === json(fresh.map((s) => s.levelFlags)), 'an edit between the steps: the saves as on the edited ROM');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
