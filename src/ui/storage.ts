// IndexedDB persistence of the working ROM (so a page reload keeps work).

import { Rom } from '../core/rom.ts';

const DB = 'smw-editor';
function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => res();
    // (a store that doesn't fit fails when the transaction commits: an abort, not an error)
    tx.onerror = tx.onabort = () => rej(tx.error ?? new Error('the browser refused to store it'));
  });
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(key);
    r.onsuccess = () => res(r.result as T | undefined);
    r.onerror = () => rej(r.error);
  });
}
export async function kvDel(key: string): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// all entries whose key starts with prefix
export async function kvEntries<T>(prefix: string): Promise<[string, T][]> {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const st = tx.objectStore('kv'), range = IDBKeyRange.bound(prefix, prefix + '￿');
    const keys = st.getAllKeys(range), vals = st.getAll(range);
    tx.oncomplete = () => res((keys.result as string[]).map((k, i) => [k, vals.result[i] as T]));
    tx.onerror = () => rej(tx.error);
  });
}

// several writes and deletes in one transaction
export async function kvWrite(put: [string, unknown][], del: string[] = []): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    for (const [k, v] of put) st.put(v, k);
    for (const k of del) st.delete(k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// everything the editor keeps in the browser (working ROM, editor data, caches, manuals)
export async function kvClear(): Promise<void> {
  const db = await open();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function kvKeys(prefix: string): Promise<string[]> {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'));
    r.onsuccess = () => res(r.result as string[]);
    r.onerror = () => rej(r.error);
  });
}

// the working ROM as stored under 'rom': image, SMC header and the editor data (sources); changed: it has changes
// that are in no project file (since the last “Save project”)
export interface RomRecord { name: string; data: Uint8Array; header: Uint8Array | null; extra?: [string, Uint8Array][]; changed: boolean }

export function romRecord(name: string, rom: Rom, changed: boolean): RomRecord {
  return { name, data: rom.output(false), header: rom.smcHeader, extra: [...rom.extra], changed };
}
// rejects when the browser can't store it (no storage, quota), also when making the record throws
export async function saveRom(name: string, rom: Rom, changed: boolean): Promise<void> {
  await kvSet('rom', romRecord(name, rom, changed));
}
export function romFromRecord(r: RomRecord): Rom {
  let full = r.data;
  if (r.header) { full = new Uint8Array(r.header.length + r.data.length); full.set(r.header); full.set(r.data, r.header.length); }
  const rom = new Rom(full);
  rom.extra = new Map(r.extra ?? []);
  return rom;
}
