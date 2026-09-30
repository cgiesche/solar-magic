// IndexedDB persistence of the working ROM (so a page reload keeps work).

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
    tx.onerror = () => rej(tx.error);
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

export async function kvKeys(prefix: string): Promise<string[]> {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'));
    r.onsuccess = () => res(r.result as string[]);
    r.onerror = () => rej(r.error);
  });
}
