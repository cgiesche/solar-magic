// Test play's rewind (src/core/rewind.ts, PlaySession.keepRewind / rewind): a state kept every few frames in a ring
// of bounded length, stepping back loads the newest from before the current frame and the game goes on exactly as
// it did from there; the ring is cleared by a savestate loaded. The play log (playlog.ts) goes back with it: the
// samples, events, lag frames and deaths after the frame gone back to are dropped. Also the memory per state and
// the time keeping the states costs.
// node tools/testrewind.ts
import { Rom } from '../src/core/rom.ts';
import { editorImage } from './fixture.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { RewindRing, REWIND_EVERY, REWIND_STATES, stateBytes } from '../src/core/rewind.ts';
import { PlayLog, LAG } from '../src/core/playlog.ts';
import { SLOT_KINDS, type SlotKind } from '../src/core/slotwatch.ts';
import { PAD } from '../src/core/ram.ts';
import { Apu, loadApu } from '../src/core/apu.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

{
  // the ring alone: the newest `size` kept, dropped from the newest end
  const r = new RewindRing<number>(3);
  check(r.length === 0 && r.newest() === undefined, 'an empty ring');
  for (let i = 1; i <= 5; i++) r.push(i);
  check(r.length === 3 && r.newest() === 5 && r.at(2) === 3 && r.at(3) === undefined, `the newest 3 of 5 kept (${r.at(0)}, ${r.at(1)}, ${r.at(2)})`);
  check(r.pop() === 5 && r.pop() === 4 && r.length === 1, 'popped from the newest end');
  r.push(6);
  check(r.newest() === 6 && r.at(1) === 3, 'pushed after popping');
  r.clear();
  check(r.length === 0 && r.pop() === undefined, 'cleared');
}

await loadApu();
const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom);
emu.snes.apu = new Apu();
emu.boot();
const w = emu.snes.wram;
// right, with a jump every 40 frames
const input = (f: number) => PAD.right | (f % 40 < 10 ? PAD.b : 0);

{
  const p = PlaySession.start(emu, 0x105);
  p.attachPPU();
  check(p.rewind() === null, 'no rewind kept: nothing to go back to');
  p.keepRewind();
  check(p.frames === 0 && p.rewind() === null, 'kept, nothing played yet: nothing to go back to');
  const at: Uint8Array[] = [];
  for (let f = 0; f < 120; f++) { p.frame(input(f)); at[p.frames] = w.slice(); }
  check(p.frames === 120, `frames counted (${p.frames})`);
  // the newest kept is the current frame's: going back skips it
  check(p.rewind() === 120 - REWIND_EVERY && same(w, at[120 - REWIND_EVERY]), `back to frame ${120 - REWIND_EVERY}: the game as it was then`);
  check(p.frames === 120 - REWIND_EVERY, 'the frame count gone back');
  check(p.rewind() === 120 - 2 * REWIND_EVERY && same(w, at[120 - 2 * REWIND_EVERY]), 'again: another step back');
  // going on from there: the game as it went on before
  const from = p.frames;
  for (let f = from; f < from + 12; f++) p.frame(input(f));
  check(p.frames === from + 12 && same(w, at[from + 12]), `released at ${from}, played on: the same frames as before (frame ${p.frames})`);
  // back to the oldest kept: it stays, no step further
  let n = 0, last = p.frames;
  for (let r = p.rewind(); r !== null; r = p.rewind()) { check(r < last, `step back to ${r}`); last = r; n++; if (n > 100) break; }
  check(last === REWIND_EVERY && same(w, at[REWIND_EVERY]), `back to the oldest kept (frame ${last}, ${n} steps)`);
  // a savestate loaded clears it
  const st = p.save();
  for (let f = 0; f < 30; f++) p.frame(input(f));
  p.load(st);
  check(p.rewind() === null, 'a savestate loaded: nothing to go back to');
  p.close();
}
{
  // bounded: a level played longer than the ring holds keeps REWIND_STATES states
  const p = PlaySession.start(emu, 0x105);
  p.keepRewind();
  for (let f = 0; f < REWIND_EVERY * (REWIND_STATES + 20); f++) p.frame();
  let n = 0;
  while (p.rewind() !== null) n++;
  check(n === REWIND_STATES - 1, `${REWIND_STATES} states kept at most (${n + 1} gone through), about ${Math.round(REWIND_EVERY * REWIND_STATES / 60)} s`);
  p.close();
}
{
  // memory and time: a state with a PPU and the sound unit; the frames with and without keeping states
  const p = PlaySession.start(emu, 0x105);
  p.attachPPU();
  const bytes = stateBytes(p.save());
  console.log(`  a state: ${(bytes / 1024).toFixed(0)} KiB, the ring: ${(bytes * REWIND_STATES / 1048576).toFixed(1)} MiB`);
  check(bytes * REWIND_STATES < 64 * 1048576, 'the ring under 64 MiB');
  const st = p.save(), N = 600;
  const time = (keep: boolean) => {
    p.load(st);
    if (keep) p.keepRewind();
    const t = performance.now();
    for (let f = 0; f < N; f++) p.frame(input(f));
    return (performance.now() - t) / N;
  };
  time(false); // (warm)
  const plain = time(false), kept = time(true);
  console.log(`  a frame: ${plain.toFixed(2)} ms, keeping states: ${kept.toFixed(2)} ms`);
  check(kept < plain * 1.25 + 0.2, 'keeping states costs little time');
  p.close();
}
{
  // the play log gone back: samples, events, lag frames and deaths after the frame dropped, open events as then
  const none = () => Object.fromEntries(SLOT_KINDS.map((k) => [k, 0])) as Record<SlotKind, number>;
  const fail = { kind: SLOT_KINDS[0], searched: 12, free: 0, replaced: false };
  const log = new PlayLog(256, 100);
  for (let f = 1; f <= 50; f++) {
    const lag = f >= 10 && f <= 30;
    log.frame(f, none(), f === 5 || f === 20 || f === 40 ? [fail] : [], lag ? LAG : 100, 0, 0, 0x105);
    if (f === 25) log.died(f, { level: 0x105, tx: 0, ty: 0, killer: { kind: 'pit' } });
  }
  check(log.events.length === 1 && log.events[0].count === 3 && log.lagFrames === 21 && log.deaths.length === 1, `before: events ${log.events.map((e) => e.count)}, lag frames ${log.lagFrames}`);
  const gone = log.rewindTo(15);
  check(gone !== null && gone.length === 1, 'back to frame 15: the death after it given back');
  check(log.history.length === 15 && log.history[14].frame === 15, `the samples up to frame 15 (${log.history.length})`);
  check(log.events.length === 1 && log.events[0].count === 1 && log.events[0].last === 5, 'the failure events as at frame 15');
  check(log.lagFrames === 6 && log.lags.length === 1 && log.lags[0].count === 6 && log.lags[0].last === 15, `the lag frames as at frame 15 (${log.lagFrames})`);
  check(log.deaths.length === 0, 'no death');
  // going on: frames merge into the events open then
  log.frame(16, none(), [fail], LAG, 0, 0, 0x105);
  check(log.events.length === 1 && log.events[0].count === 2 && log.lags[0].count === 7, 'played on: the open events go on');
  check(log.rewindTo(200) === null && log.rewindTo(0) === null, 'a frame not kept: nothing done');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
