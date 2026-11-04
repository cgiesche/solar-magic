// Results kept while the ROM bytes they read are unchanged (CONTEXT.md: the result learner keeps its results so, and
// so do the sprite memory check's groups, the prefab suggestions' levels, the overworld's loads and the palette tab's
// color sources). One store for all of them: results by key and input (a pair, never joined into one string), each
// with what it read (its dependencies, checked as the store's Validity says: against the ROM's fingerprint, or against
// the ROM edits since it was recorded); a result whose bytes changed is dropped when it is next asked for (or swept).
// A store checking against the fingerprint may keep several results per input instead (contents: those of the latest
// ROM states it was made on, the bytes they read differing), so that an undo or a redo finds the one made before
// (#386); a result whose bytes changed is then kept until newer ones push it out.
// A key keeps the results of its latest used inputs (inputsPerKey: switching between levels whose sprite memory
// differs doesn't learn their sprite images again); the store keeps its latest used keys (limit: keys, not inputs, so
// a key with several inputs doesn't push others out sooner). A round (a check, a run over all levels) keeps all keys
// it used, also more than the limit, and so does the latest finished round while the next one runs (a round left
// unfinished doesn't replace it): the next round over the same finds them. Getting and setting take constant time
// (a key's inputs are looked through, not all results). Persisted or memory only is the owner's choice: hooks tell a
// persisting owner (romdeps.ts ResultCache) what to write.

export const INPUTS_PER_KEY = 4; // inputs a key keeps results for (the latest used)

// How a kept result's dependencies D are checked: stamp() changes whenever results may no longer hold (a result checked
// at the current stamp isn't checked again), holds(d) whether d's bytes are unchanged; current(d): d is as of the
// current stamp (else it is checked when first used; default: it is)
export interface Validity<D> {
  stamp(): number;
  holds(d: D): boolean;
  current?(d: D): boolean;
}

// what a persisting owner is told: a result set (put) or dropped (drop), the order of a key's inputs changed (order)
export interface KeptHooks {
  put(key: string, input: string | undefined): void;
  drop(key: string, input: string | undefined): void;
  order(key: string): void;
}

export interface KeptOptions<D> {
  validity: Validity<D>;
  inputsPerKey?: number; // (default INPUTS_PER_KEY)
  contents?: number; // results kept per input, the latest made (default 1; more only for a Validity by content, no hooks)
  limit?: number; // keys kept, the latest used (default: no limit)
  hooks?: KeptHooks;
}

export interface Kept<T, D> { data: T; deps: D }

// (checkedAt / failedAt: the stamp it was last found to hold / not to hold at)
interface Slot<D> { input: string | undefined; data: unknown; deps: D; checked: number; failedAt: number }
interface KeyEntry<D> { slots: Slot<D>[]; round: number } // slots: the latest used input first (its contents in a row)

export class KeptResults<D> {
  private v: Validity<D>;
  private perKey: number;
  private contents: number;
  private limit: number;
  private hooks: KeptHooks | null;
  private keys = new Map<string, KeyEntry<D>>(); // the least recently used first
  private round = 0; // 0: none started (only the limit bounds)
  private used = 0; // keys used in the round
  private finished = 0; // keys used in the latest finished round
  private unchecked: [string, Slot<D>][] = []; // results sweep() checks next, for stamp sweepStamp
  private sweepStamp: number | null = null;

  constructor(o: KeptOptions<D>) {
    this.v = o.validity;
    this.perKey = o.inputsPerKey ?? INPUTS_PER_KEY;
    this.contents = o.contents ?? 1;
    if (this.contents > 1 && o.hooks) throw new Error('a persisted store keeps one result per input');
    this.limit = o.limit ?? Infinity;
    this.hooks = o.hooks ?? null;
  }

  // starts a round: from now on the keys used are kept (with those of the latest finished round)
  startRound(): void {
    this.round++;
    this.used = 0;
  }
  // the round is finished: its keys are kept until the next one finishes
  endRound(): void { this.finished = this.used; }

  get<T>(key: string, input?: string): T | undefined { return this.entry<T>(key, input)?.data; }

  // the result with what it read, if it holds (of several contents the one that holds); it becomes the latest used
  entry<T>(key: string, input?: string): Kept<T, D> | undefined {
    const k = this.keys.get(key);
    if (!k) return undefined;
    const i = k.slots.findIndex((s) => s.input === input && (this.contents === 1 || this.check(s)));
    if (i < 0) return undefined;
    const s = k.slots[i];
    if (this.contents === 1 && !this.check(s)) { this.removeSlot(key, k, i); return undefined; }
    // (to the front: its input's other contents after it)
    const others = k.slots.filter((e) => e.input === input && e !== s);
    if (i > 0 || others.length) {
      k.slots = [s, ...others, ...k.slots.filter((e) => e.input !== input)];
      this.hooks?.order(key);
    }
    this.touch(key, k);
    return { data: s.data as T, deps: s.deps };
  }

  // the result kept for the input (whether it holds or not, not made the latest used; of several contents the latest
  // made or used)
  peek<T>(key: string, input?: string): Kept<T, D> | undefined {
    const s = this.keys.get(key)?.slots.find((e) => e.input === input);
    return s && { data: s.data as T, deps: s.deps };
  }

  // the inputs a key keeps results for, the latest used first (an input of several contents once)
  inputs(key: string): (string | undefined)[] { return [...new Set(this.keys.get(key)?.slots.map((s) => s.input))]; }

  // all results kept (also those not checked yet), by key and input (an input of several contents more than once)
  *all(): Iterable<[string, string | undefined, Kept<unknown, D>]> {
    for (const [key, k] of this.keys) for (const s of k.slots) yield [key, s.input, { data: s.data, deps: s.deps }];
  }

  // keeps data for the input as the key's latest used (current: deps are as of the current stamp, Validity.current); of
  // several contents the oldest beyond them goes, and one that holds now (made on the same ROM state: replaced)
  set(key: string, data: unknown, deps: D, input?: string, current = this.v.current?.(deps) ?? true): void {
    let k = this.keys.get(key);
    if (!k) this.keys.set(key, (k = { slots: [], round: -1 }));
    const older = this.contents === 1 ? [] : k.slots.filter((s) => s.input === input && !this.check(s)).slice(0, this.contents - 1);
    k.slots = [{ input, data, deps, checked: current ? this.v.stamp() : NaN, failedAt: NaN }, ...older, ...k.slots.filter((s) => s.input !== input)];
    this.hooks?.put(key, input);
    if (k.slots.length > 1 || input !== undefined) this.hooks?.order(key);
    // (the least recently used inputs beyond perKey go, all their contents)
    for (const inputs = new Set(k.slots.map((s) => s.input)); inputs.size > this.perKey;) {
      const last = k.slots[k.slots.length - 1].input;
      inputs.delete(last);
      for (let j = k.slots.length - 1; j >= 0; j--) if (k.slots[j].input === last) this.removeSlot(key, k, j);
    }
    this.touch(key, k);
    while (this.keys.size > Math.max(this.limit, this.finished + this.used)) {
      const [first, e] = this.keys.entries().next().value!;
      this.removeKey(first, e);
    }
  }

  // keeps data for the input as the key's least recently used, if the key keeps nothing for it and has room (results
  // read from storage, checked when first used; false: not kept). Not bounded by the limit (a store without one: the
  // result cache's)
  setOlder(key: string, data: unknown, deps: D, input?: string): boolean {
    let k = this.keys.get(key);
    if (k?.slots.some((s) => s.input === input)) return true;
    if (k && k.slots.length >= this.perKey) return false;
    if (!k) this.keys.set(key, (k = { slots: [], round: -1 }));
    k.slots.push({ input, data, deps, checked: NaN, failedAt: NaN });
    this.sweepStamp = null; // (the next sweep checks it)
    return true;
  }

  // checks up to count results not checked at the current stamp yet (of any input, used or not) and drops those that
  // no longer hold, so a persisting owner loses them without them being asked for; false once all are checked. A new
  // stamp starts again with the results not checked since.
  sweep(count: number): boolean {
    const stamp = this.v.stamp();
    if (this.sweepStamp !== stamp) {
      this.sweepStamp = stamp;
      this.unchecked = [];
      for (const [key, k] of this.keys) for (const s of k.slots) if (s.checked !== stamp) this.unchecked.push([key, s]);
    }
    for (; count > 0 && this.unchecked.length; count--) {
      const [key, s] = this.unchecked.pop()!, k = this.keys.get(key), i = k ? k.slots.indexOf(s) : -1;
      if (i < 0 || s.checked === stamp) continue; // (replaced, dropped or checked since)
      if (!this.check(s) && this.contents === 1) this.removeSlot(key, k!, i); // (several contents: kept for an undo)
    }
    return this.unchecked.length > 0;
  }

  // s holds: checked once per stamp
  private check(s: Slot<D>): boolean {
    const stamp = this.v.stamp();
    if (s.checked === stamp) return true;
    if (s.failedAt === stamp) return false;
    if (!this.v.holds(s.deps)) { s.failedAt = stamp; return false; }
    s.checked = stamp;
    return true;
  }

  // drops the results of key, of all inputs
  delete(key: string): void {
    const k = this.keys.get(key);
    if (k) this.removeKey(key, k);
  }

  // the key becomes the latest used
  private touch(key: string, k: KeyEntry<D>): void {
    if (this.round && k.round !== this.round) { k.round = this.round; this.used++; }
    this.keys.delete(key);
    this.keys.set(key, k);
  }

  private removeSlot(key: string, k: KeyEntry<D>, i: number): void {
    const [s] = k.slots.splice(i, 1);
    if (!k.slots.length) this.forget(key, k);
    this.hooks?.drop(key, s.input);
    if (s.input !== undefined || k.slots.length) this.hooks?.order(key);
  }

  private removeKey(key: string, k: KeyEntry<D>): void {
    this.forget(key, k);
    for (const s of k.slots) this.hooks?.drop(key, s.input);
    if (k.slots.some((s) => s.input !== undefined)) this.hooks?.order(key);
  }

  private forget(key: string, k: KeyEntry<D>): void {
    if (this.round && k.round === this.round) this.used--;
    this.keys.delete(key);
  }
}
