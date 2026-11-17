// The stores of the working ROM in the browser (ui/projectstore.ts): debounced after ROM edits, at once after a level
// save; a closed store (the project closed or replaced by another) never writes again, whatever was still pending.
// node tools/testprojectstore.ts
import { ProjectStore } from '../src/ui/projectstore.ts';

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
const make = () => {
  const t = new Timers();
  const s = { stores: 0 };
  const store = new ProjectStore({ store: () => { s.stores++; return Promise.resolve(); }, setTimer: t.set, clearTimer: t.clear });
  return { t, s, store };
};

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

if (bad) { console.error(`${bad} failed`); process.exit(1); }
console.log('all ok');
