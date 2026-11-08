// The editor's preferences kept in the browser (localStorage): each one named, typed, with its default; a value
// not of its type, a browser without storage or one refusing it gives the default (a value set then holds for the
// session). Every key starts with PREF_PREFIX. A change is told to the preference's listeners. (clearPrefs empties the
// whole storage – closing the project, the page loaded anew after it.)
// Families: values kept per key (a workspace, a ROM, a level), cleared or looked for by the keys' start.

export const PREF_PREFIX = 'smwe:';

type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem' | 'clear'>;
let override: Store | null | undefined; // tests: a storage of their own (null: none)
function store(): Store | null {
  if (override !== undefined) return override;
  return (globalThis as { localStorage?: Store }).localStorage ?? null;
}
// tests: the storage to use (null: none; undefined: the browser's again)
export function setPrefStorage(s: Store | null | undefined): void {
  override = s;
  session.clear();
}

const session = new Map<string, string | null>(); // what was set while the storage refused (null: reset)

function read(key: string): string | null {
  if (session.has(key)) return session.get(key)!;
  try { return store()?.getItem(key) ?? null; } catch { return null; }
}
function write(key: string, v: string | null): void {
  try {
    const s = store();
    if (!s) throw new Error('no storage');
    if (v === null) s.removeItem(key); else s.setItem(key, v);
    session.delete(key);
  } catch { session.set(key, v); }
}
function storedKeys(start: string): string[] {
  const keys = new Set<string>();
  try {
    const s = store();
    if (s) for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k?.startsWith(start)) keys.add(k); }
  } catch { /* no storage */ }
  for (const [k, v] of session) if (k.startsWith(start)) { if (v === null) keys.delete(k); else keys.add(k); }
  return [...keys];
}

export interface Pref<T> {
  readonly key: string; // as kept (with the prefix)
  get(): T;
  set(v: T): void;
  reset(): void; // back to the default, nothing kept
  onChange(fn: (v: T) => void): () => void; // returns: taking the listener off
}

interface Codec<T> { parse(s: string): T | undefined; format(v: T): string }

function pref<T>(name: string, def: T | (() => T), codec: Codec<T>): Pref<T> {
  const key = PREF_PREFIX + name;
  const fallback = (): T => (typeof def === 'function' ? (def as () => T)() : def);
  const listeners = new Set<(v: T) => void>();
  const get = (): T => {
    const s = read(key);
    if (s === null) return fallback();
    const v = codec.parse(s);
    return v === undefined ? fallback() : v;
  };
  const tell = (before: string, v: T) => { if (codec.format(v) !== before) for (const fn of [...listeners]) fn(v); };
  return {
    key, get,
    set(v) { const before = codec.format(get()); write(key, codec.format(v)); tell(before, v); },
    reset() { const before = codec.format(get()); write(key, null); tell(before, get()); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

export function boolPref(name: string, def: boolean | (() => boolean)): Pref<boolean> {
  return pref(name, def, { parse: (s) => (s === '1' ? true : s === '0' ? false : undefined), format: (v) => (v ? '1' : '0') });
}

// valid: whether a kept number is taken (else the default)
export function numberPref(name: string, def: number | (() => number), valid: (v: number) => boolean = () => true): Pref<number> {
  return pref(name, def, {
    parse: (s) => { const v = Number(s); return s.trim() !== '' && Number.isFinite(v) && valid(v) ? v : undefined; },
    format: (v) => String(v),
  });
}

// valid: whether the value read is of the type (else the default)
export function jsonPref<T>(name: string, def: T | (() => T), valid: (v: unknown) => v is T): Pref<T> {
  return pref(name, def, {
    parse: (s) => { try { const v: unknown = JSON.parse(s); return valid(v) ? v : undefined; } catch { return undefined; } },
    format: (v) => JSON.stringify(v),
  });
}

export interface PrefFamily<T> {
  at(key: string): Pref<T>; // the value kept for this key (the same object for the same key)
  any(start: string): boolean; // whether a value is kept for a key starting so
  clear(start: string): void; // every value of a key starting so back to the default
}

// name: the family's start (as `${name}${key}`); make: the preference of one full name (a boolPref, numberPref, …)
export function prefFamily<T>(name: string, make: (fullName: string) => Pref<T>): PrefFamily<T> {
  const made = new Map<string, Pref<T>>();
  const at = (k: string): Pref<T> => {
    let p = made.get(k);
    if (!p) { p = make(name + k); made.set(k, p); }
    return p;
  };
  return {
    at,
    any: (start) => storedKeys(PREF_PREFIX + name + start).length > 0,
    clear(start) {
      const full = PREF_PREFIX + name;
      for (const k of storedKeys(full + start)) at(k.slice(full.length)).reset();
    },
  };
}

// everything the editor keeps in the browser gone (closing the project)
export function clearPrefs(): void {
  try { store()?.clear(); } catch { /* no storage */ }
  session.clear();
}
