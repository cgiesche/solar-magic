// Views watch the ROM bytes they read (romwatch.ts): told only when a ROM change changed one of them; a held watch
// (a stroke being drawn) is told nothing and holds the ROM's other followers (held), a change meanwhile is told after
// release; an own edit is taken as seen; a stopped watch is told nothing until run again (#271).
import { Rom } from '../src/core/rom.ts';
import { RomWatch } from '../src/core/romwatch.ts';
import { cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const A = 0x00b0a0, B = 0x0d8000;
const rom = new Rom(cleanImage());
const watch = new RomWatch(rom);
let told = 0;
const w = watch.watch(() => { told++; w.run(() => rom.r16(A)); });
w.run(() => rom.r16(A));
const write = (at: number) => { rom.w16(at, rom.r16(at) ^ 1); watch.notify(); };

write(B);
check(told === 0, 'a change of a byte not read: not told');
write(A);
check(told === 1, 'a change of a byte read: told');
write(A);
check(told === 2, 'told again after it ran again');

w.hold();
check(watch.held, 'a watch held: the watches are held');
write(A);
check(told === 2, 'held: not told');
w.release();
check(!watch.held, 'released: not held');
write(B);
check(told === 3, 'released: the change while held told at the next notify');

w.hold();
write(A);
w.release();
w.own(() => write(A));
write(B);
check(told === 3, 'an own edit after a stroke: taken as seen, also the change while held');

w.stop();
write(A);
check(told === 3, 'stopped: not told');
w.run(() => rom.r16(A));
write(A);
check(told === 4, 'run again: told');

// a failing watch doesn't keep the others from being told
{
  let other = 0;
  const f = watch.watch(() => { throw new Error('boom'); });
  f.run(() => rom.r16(A));
  const o = watch.watch(() => { other++; });
  o.run(() => rom.r16(A));
  const error = console.error;
  console.error = () => {};
  try { write(A); } finally { console.error = error; }
  check(other === 1, 'a failing watch: the others told');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('rom watch ok');
