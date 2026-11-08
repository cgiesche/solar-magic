// The editor's preferences kept in the browser (ui/prefs.ts): named, typed, with defaults; a browser without
// storage (or one that throws) gets the default; a change is told to its listeners; families of keyed values.
// node tools/testprefs.ts
import { boolPref, numberPref, jsonPref, prefFamily, PREF_PREFIX, setPrefStorage, clearPrefs } from '../src/ui/prefs.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

class MemStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const mem = new MemStorage();
setPrefStorage(mem);

{
  const p = boolPref('test-on', true);
  check(p.key === PREF_PREFIX + 'test-on' && PREF_PREFIX.length > 0, 'keys get one common prefix');
  check(p.get() === true, 'nothing kept: the default');
  const seen: boolean[] = [];
  const off = p.onChange((v) => seen.push(v));
  p.set(false);
  check(p.get() === false && mem.getItem(p.key) === '0', 'set: kept');
  p.set(false);
  check(seen.join() === 'false', 'a change is told once, the same value again not');
  off();
  p.set(true);
  check(seen.join() === 'false', 'a listener taken off hears nothing more');
  p.reset();
  check(mem.getItem(p.key) === null && p.get() === true, 'reset: the default, nothing kept');
}
{
  let reduced = true;
  const p = boolPref('test-lazy', () => !reduced);
  check(p.get() === false, 'a default given as a function is asked when nothing is kept');
  reduced = false;
  check(p.get() === true, '... every time');
  mem.setItem(p.key, 'garbage');
  check(p.get() === true, 'a value that is not one of the type: the default');
}
{
  const n = numberPref('test-w', 300, (v) => v >= 200 && v <= 1600);
  check(n.get() === 300, 'number: the default');
  n.set(500);
  check(n.get() === 500 && mem.getItem(n.key) === '500', 'number: kept');
  mem.setItem(n.key, '100');
  check(n.get() === 300, 'number out of its range: the default');
  mem.setItem(n.key, 'x');
  check(n.get() === 300, 'number not a number: the default');
}
{
  const j = jsonPref<number[]>('test-list', [], (v): v is number[] => Array.isArray(v));
  check(j.get().length === 0, 'json: the default');
  j.set([1, 2]);
  check(j.get().join() === '1,2', 'json: kept');
  mem.setItem(j.key, '{bad');
  check(j.get().length === 0, 'json not readable: the default');
}
{
  const f = prefFamily('test-fam:', (k) => numberPref(k, 0));
  f.at('a:1').set(1); f.at('a:2').set(2); f.at('b:1').set(3);
  check(f.at('a:1').get() === 1 && f.at('b:1').get() === 3, 'family: a value per key');
  check(f.at('a:1') === f.at('a:1'), 'family: the same preference for the same key');
  check(f.any('a:') && !f.any('c:'), 'family: whether any key starts so');
  f.clear('a:');
  check(f.at('a:1').get() === 0 && f.at('a:2').get() === 0 && f.at('b:1').get() === 3, 'family: cleared by the keys\' start');
}
{
  // a browser without storage, or one that throws
  setPrefStorage(null);
  const p = boolPref('test-none', true);
  p.set(false);
  check(p.get() === false, 'no storage: the value holds for this session');
  const deny = (): never => { throw new Error('denied'); };
  setPrefStorage({ get length(): number { return deny(); }, key: deny, getItem: deny, setItem: deny, removeItem: deny, clear: deny });
  const q = boolPref('test-throw', true);
  check(q.get() === true, 'storage throwing: the default');
  q.set(false);
  check(q.get() === false, 'storage throwing: set holds for this session');
  const f = prefFamily('test-fam2:', (k) => boolPref(k, false));
  check(!f.any(''), 'storage throwing: no family keys');
  f.at('x').set(true);
  check(f.any(''), 'storage throwing: a value set this session is found');
  f.clear('');
  check(!f.any('') && f.at('x').get() === false, 'storage throwing: and cleared');
  setPrefStorage(mem);
}
{
  const p = boolPref('test-clear', false);
  p.set(true);
  mem.setItem('foreign', 'x');
  clearPrefs();
  check(p.get() === false && mem.length === 0, 'clearPrefs: everything kept in the browser gone');
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
