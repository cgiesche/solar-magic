// The background scheduler (core/scheduler.ts): slices of background work run as low-priority tasks, wait parked by
// their key while something holds the background (a dialog, the music player) and continue once nothing does.
import { Scheduler } from '../src/core/scheduler.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const idle = () => new Promise<void>((r) => setTimeout(r, 20));

// a step runs later, not at once
{
  const s = new Scheduler(() => false), ran: string[] = [];
  s.later('a', () => ran.push('a'));
  check(ran.length === 0, 'not run at once');
  await idle();
  check(ran.join() === 'a', 'run in the background');
}

// held: parked by its key (the latest step of a key kept), run once nothing holds it and it resumes
{
  let held = true;
  const s = new Scheduler(() => held), ran: string[] = [];
  check(s.held(), 'held() as given');
  s.later('a', () => ran.push('a1'));
  s.later('a', () => ran.push('a2'));
  s.later('b', () => ran.push('b'));
  await idle();
  check(ran.length === 0, 'held: nothing runs');
  s.resume();
  await idle();
  check(ran.length === 0, 'resumed while held: nothing runs');
  held = false;
  s.resume();
  await idle();
  check(ran.sort().join() === 'a2,b', 'resumed: the latest step of each key runs');
  s.resume();
  await idle();
  check(ran.length === 2, 'resumed again: nothing more');
}

// held between scheduling and running: parked then
{
  let held = false;
  const s = new Scheduler(() => held), ran: string[] = [];
  s.later('a', () => ran.push('a'));
  held = true;
  await idle();
  check(ran.length === 0, 'held when its turn comes: parked');
  held = false;
  s.resume();
  await idle();
  check(ran.join() === 'a', 'then run on resume');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
