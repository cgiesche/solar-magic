// ROM edit session: one labelled edit is one undo step, all or nothing (an edit that throws or reports
// failure leaves ROM and editor data as they were and records nothing), the open level is stored before
// it, and the follow-ups run from what changed – also after undo and redo; settled runs once an edit (also a failed one)
// or undo/redo is done with its follow-ups, running until then (#220).
import { Rom } from '../src/core/rom.ts';
import { RomEditSession, allOrNothing, type FollowUp } from '../src/core/romedit.ts';
import { cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameExtra = (a: Map<string, Uint8Array>, b: Map<string, Uint8Array>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

const A = 0x00b0a0, B = 0x0d8000;
// follow-ups watching one word each, counting their runs
function setup() {
  const rom = new Rom(cleanImage());
  const runs = { a: 0, b: 0, written: 0, recorded: 0, prepared: 0 };
  const follow = (at: number, k: 'a' | 'b'): FollowUp => ({ read: (r) => String(r.r16(at)), changed: () => { runs[k]++; } });
  const s = new RomEditSession(rom, {
    prepare: () => { runs.prepared++; },
    followUps: [follow(A, 'a'), follow(B, 'b')],
    written: (w) => { runs.written++; if (w.recorded) runs.recorded++; },
  });
  return { rom, s, runs };
}

// a plain edit: one undo step, follow-ups by what changed
{
  const { rom, s, runs } = setup();
  const r = s.edit('Color', () => { rom.w16(A, 0x1234); return 7; });
  check(r === 7 && s.history.undoStack.length === 1 && s.history.undoStack[0].label === 'Color', 'edit: value passed on, one undo step');
  check(runs.prepared === 1 && runs.written === 1 && runs.recorded === 1 && runs.a === 1 && runs.b === 0, 'edit: prepared, written, only the follow-up whose data changed');
  s.undo();
  check(rom.r16(A) !== 0x1234 && runs.a === 2 && runs.written === 2 && runs.recorded === 1 && runs.prepared === 1, 'undo: follow-up again, nothing recorded, not prepared');
  s.redo();
  check(rom.r16(A) === 0x1234 && runs.a === 3, 'redo: follow-up again');
  s.edit('Nothing', () => {});
  check(s.history.undoStack.length === 1 && runs.written === 3, 'an edit changing nothing: no step, nothing written');
}

// all or nothing: throws
{
  const { rom, s, runs } = setup();
  const data = rom.data.slice(), extra = new Map(rom.extra);
  let threw = false;
  try { s.edit('Broken', () => { rom.w16(A, 1); rom.extra.set('x', new Uint8Array([1])); rom.expand(0x100000); throw new Error('boom'); }); } catch (e) { threw = (e as Error).message === 'boom'; }
  check(threw && same(rom.data, data) && sameExtra(rom.extra, extra), 'throws: error passed on, ROM and editor data as before');
  check(!s.history.undoStack.length && !s.history.open && runs.a === 0 && runs.written === 0, 'throws: no undo step, no follow-ups');
}

// all or nothing: reports failure
{
  const { rom, s, runs } = setup();
  const data = rom.data.slice(), extra = new Map(rom.extra);
  const r = s.edit('Failed', () => { rom.w16(A, 1); rom.extra.set('x', new Uint8Array([1])); return { ok: false, errors: ['no'] }; });
  check(!r.ok && r.errors[0] === 'no' && same(rom.data, data) && sameExtra(rom.extra, extra), 'ok false: result passed on, ROM and editor data as before');
  check(!s.history.undoStack.length && runs.a === 0 && runs.written === 0, 'ok false: no undo step, no follow-ups');
  const ok = s.edit('Fine', () => { rom.w16(A, 1); return { ok: true }; });
  check(ok.ok && s.history.undoStack.length === 1, 'ok true: recorded');
}

// async: one step for all of it, rolled back when it fails
{
  const { rom, s, runs } = setup();
  const data = rom.data.slice();
  await s.editAsync('Songs', async () => { rom.w16(A, 1); await Promise.resolve(); rom.w16(B, 2); return { ok: true }; });
  check(s.history.undoStack.length === 1 && runs.a === 1 && runs.b === 1, 'async: one step, follow-ups');
  s.undo();
  check(same(rom.data, data), 'async: undone as one');
  const r = await s.editAsync('Songs failed', async () => { rom.w16(A, 3); await Promise.resolve(); return { ok: false }; });
  let threw = false;
  try { await s.editAsync('Songs broken', async () => { rom.w16(A, 3); await Promise.resolve(); throw new Error('amk'); }); } catch { threw = true; }
  check(!r.ok && threw && same(rom.data, data) && s.history.undoStack.length === 0 && !s.history.open, 'async: failed or thrown, ROM as before, no step');
}

// nested: part of the outer step; a failing inner edit only undoes its own part
{
  const { rom, s, runs } = setup();
  s.edit('Outer', () => {
    rom.w16(A, 5);
    const inner = s.edit('Inner', () => { rom.w16(B, 6); return { ok: false }; });
    check(!inner.ok && rom.r16(B) !== 6 && rom.r16(A) === 5, 'nested failure: only the inner part undone');
    s.edit('Inner 2', () => rom.w16(B, 7));
  });
  check(s.history.undoStack.length === 1 && runs.prepared === 1 && runs.written === 1 && runs.a === 1 && runs.b === 1, 'nested: one step, follow-ups once');
  const v = allOrNothing(rom, () => { rom.w16(A, 9); return { ok: false }; });
  check(!v.ok && rom.r16(A) === 5, 'allOrNothing: a failed part undone');
}

// not recorded: still all or nothing, follow-ups, no undo step
{
  const { rom, s, runs } = setup();
  s.edit('Overworld saved', () => rom.w16(A, 1), { record: false });
  check(!s.history.undoStack.length && runs.written === 1 && runs.recorded === 0 && runs.a === 1, 'not recorded: written, follow-ups, no step');
  const data = rom.data.slice();
  try { s.edit('Overworld saved', () => { rom.w16(A, 2); throw new Error('full'); }, { record: false }); } catch { /* passed on */ }
  check(same(rom.data, data), 'not recorded: rolled back when it throws');
}

// quick edits with the same key merge into one step
{
  const { rom, s } = setup();
  s.edit('Slider', () => rom.w16(A, 1), { key: 'c' });
  s.edit('Slider', () => rom.w16(A, 2), { key: 'c' });
  check(s.history.undoStack.length === 1, 'same key: merged');
}

// settled: once per edit or undo/redo, after its follow-ups, also when it failed or changed nothing; running until then
{
  const rom = new Rom(cleanImage());
  const log: string[] = [];
  let s!: RomEditSession;
  const at = (what: string) => () => log.push(`${what}${s.running ? ' running' : ''}`);
  s = new RomEditSession(rom, {
    prepare: at('prepare'),
    written: at('written'),
    followUps: [{ read: (r) => String(r.r16(A)), changed: at('follow') }],
    settled: at('settled'),
  });
  s.edit('Color', () => { rom.w16(A, 0x4321); s.edit('Inner', () => rom.w16(B, 1)); });
  check(log.join() === 'prepare running,written running,follow running,settled' && !s.running, `settled after the follow-ups, once with an inner edit (${log})`);
  log.length = 0;
  s.undo();
  check(log.join() === 'written running,follow running,settled', `undo: settled after the follow-ups (${log})`);
  log.length = 0;
  try { s.edit('Fails', () => { rom.w16(A, 1); throw new Error('no'); }); } catch { /* passed on */ }
  s.edit('Nothing', () => {});
  check(log.join() === 'prepare running,settled,prepare running,settled' && !s.running, `a failed edit and one changing nothing: settled (${log})`);
  log.length = 0;
  await s.editAsync('Songs', async () => { await Promise.resolve(); log.push(`awaited${s.running ? ' running' : ''}`); rom.w16(A, 2); });
  check(log.join() === 'prepare running,awaited running,written running,follow running,settled', `an awaited edit: running until settled (${log})`);
}

console.log(bad ? `${bad} failures` : 'romedit ok');
if (bad) process.exit(1);
