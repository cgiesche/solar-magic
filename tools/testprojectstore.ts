// The stores of the working ROM in the browser (ui/projectstore.ts): debounced after ROM edits, at once after a level
// save; a closed store (the project closed or replaced by another) never writes again, whatever was still pending.
// A failing store is told once per streak of failures; the project knows whether it changed since “Save project”.
// node tools/testprojectstore.ts
import { ProjectStore, closeWarning } from '../src/ui/projectstore.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// timers run by hand
class Timers {
  private next = 1;
  private m = new Map<number, () => void>();
  set = (fn: () => void): number => { this.m.set(this.next, fn); return this.next++; };
  clear = (id: number): void => { this.m.delete(id); };
  get size() { return this.m.size; }
  run(): void { const fns = [...this.m.values()]; this.m.clear(); for (const fn of fns) fn(); }
}
const make = (changed = false) => {
  const t = new Timers();
  const s = { stores: 0, fail: false, failed: [] as unknown[], changes: 0 };
  const store = new ProjectStore({
    store: () => { s.stores++; return s.fail ? Promise.reject(new Error('quota')) : Promise.resolve(); },
    setTimer: t.set, clearTimer: t.clear,
    failed: (e) => s.failed.push(e), changed: () => s.changes++,
  }, changed);
  return { t, s, store };
};
// (the stores' promises settled)
const settled = () => new Promise((r) => setTimeout(r, 0));

{
  const { t, s, store } = make();
  store.soon();
  store.soon();
  check(s.stores === 0 && t.size === 1 && store.pending, 'ROM edits in quick succession: one store pending');
  t.run();
  check(s.stores === 1 && !store.pending, 'stored once after the wait');
  store.soon();
  store.now();
  check(s.stores === 2 && t.size === 0, 'a level save stores at once, the pending store is dropped');
  store.flush();
  check(s.stores === 2, 'nothing pending: leaving the page stores nothing');
  store.soon();
  store.flush();
  check(s.stores === 3 && t.size === 0, 'leaving the page stores a pending ROM edit');
}
{
  // a ROM edit, then another project is opened at once: the old ROM is never stored (#499)
  const { t, s, store } = make();
  store.soon();
  store.close();
  check(!store.pending && t.size === 0, 'closed: the pending store is dropped');
  t.run();
  store.soon();
  t.run();
  store.now();
  store.flush();
  check(s.stores === 0 && t.size === 0, 'a closed store never writes: not later, not at once, not when leaving the page');
}

{
  // a store that fails is told once per streak of failures (#500)
  const { s, store } = make();
  s.fail = true;
  store.now();
  await settled();
  check(s.failed.length === 1 && (s.failed[0] as Error).message === 'quota', 'a failed store is told, with its error');
  store.now();
  store.now();
  await settled();
  check(s.failed.length === 1, 'the stores failing after it are not told again');
  s.fail = false;
  store.now();
  await settled();
  s.fail = true;
  store.now();
  await settled();
  check(s.failed.length === 2, 'a store that worked ends the streak: the next failure is told');
  store.close();
  check(s.failed.length === 2, 'closing tells nothing');
}
{
  // changed since “Save project” (#500)
  const { t, s, store } = make();
  check(!store.changed && !make(false).store.changed && make(true).store.changed, 'starts as the project was opened (or stored)');
  store.touch();
  store.soon();
  store.touch();
  check(store.changed && s.changes === 1, 'a ROM change: changed, told once');
  const stores = s.stores;
  store.saved(store.version);
  check(!store.changed && s.stores === stores + 1 && t.size === 0, 'Save project: unchanged again, stored with the ROM at once');
  // an edit while the file was being written is not in it
  const v = store.version;
  store.touch();
  store.saved(v);
  check(store.changed && s.changes === 2, 'a change made while the project file was written stays a change');
  store.saved(store.version);
  store.close();
  store.touch();
  check(!store.changed && s.changes === 2, 'a closed project changes no more');
}
{
  check(closeWarning(false, false) === null, 'close guard: nothing to lose, no question');
  check(/level/.test(closeWarning(true, false) ?? '') && /level/.test(closeWarning(true, true) ?? ''), 'close guard: unsaved changes in the level first');
  check(/project file/.test(closeWarning(false, true) ?? ''), 'close guard: changes not in a project file yet');
}

if (bad) { console.error(`${bad} failed`); process.exit(1); }
console.log('all ok');
