// The event progress (CONTEXT.md "Event progress"): which of the overworld's events are passed – any set of them,
// applied in their number order as the game does when it loads a save. Given as a count n (events 0 … n-1 passed: a
// prefix, what the World check and the exits' edges walk through) or as any set: the event bits ($1F02, ram.ts
// owEvents) – event e is bit $80 >> e%8 of byte e/8 (the game's masks at $04E44B). A prefix given as a set is the
// same progress as its count: the same key (progressKey), so what is kept for it is found either way.

export const OW_EVENTS = 0x78; // 15 bytes of event bits
const BYTES = OW_EVENTS / 8;

// any set of passed events, as the event bits
export type EventSet = Uint8Array;
export type EventProgress = number | EventSet;

// the event bits of a progress (a new array)
export function eventBits(p: EventProgress): Uint8Array {
  if (typeof p !== 'number') return Uint8Array.from(p.subarray(0, BYTES));
  return eventSetOf(Array.from({ length: Math.max(0, Math.min(p, OW_EVENTS)) }, (_, e) => e));
}
// the set of the events given
export function eventSetOf(events: Iterable<number>): EventSet {
  const b = new Uint8Array(BYTES);
  for (const e of events) if (e >= 0 && e < OW_EVENTS) b[e >> 3] |= 0x80 >> (e & 7);
  return b;
}
// whether event e is passed at the progress
export function isPassed(p: EventProgress, e: number): boolean {
  if (typeof p === 'number') return e >= 0 && e < Math.min(p, OW_EVENTS);
  return e >= 0 && e < OW_EVENTS && (p[e >> 3] & (0x80 >> (e & 7))) !== 0;
}
// the events passed, in number order
export function passedEvents(p: EventProgress): number[] {
  const out: number[] = [];
  for (let e = 0; e < OW_EVENTS; e++) if (isPassed(p, e)) out.push(e);
  return out;
}
export const passedCount = (p: EventProgress): number => passedEvents(p).length;
// n when the progress is the prefix of events 0 … n-1, else -1
export function prefixLength(p: EventProgress): number {
  if (typeof p === 'number') return Math.max(0, Math.min(p, OW_EVENTS));
  let n = 0;
  while (n < OW_EVENTS && isPassed(p, n)) n++;
  for (let e = n; e < OW_EVENTS; e++) if (isPassed(p, e)) return -1;
  return n;
}
// the progress as kept and asked for: a prefix as its count, else the set (a copy)
export function canonicalProgress(p: EventProgress): EventProgress {
  const n = prefixLength(p);
  return n >= 0 ? n : eventBits(p);
}
// the key of a progress: a prefix's count ("5"), else the event bits in hex ("e:ff80…")
export function progressKey(p: EventProgress): string {
  const n = prefixLength(p);
  return n >= 0 ? String(n) : `e:${[...eventBits(p)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export const sameProgress = (a: EventProgress, b: EventProgress): boolean => progressKey(a) === progressKey(b);

const hex2 = (e: number) => e.toString(16).toUpperCase().padStart(2, '0');
// the progress in words: "before events", "after event 0C" (a prefix), "with every event passed", "with events 01, 03,
// 09" (another set of up to four), "with 14 of 78 events" (a larger one)
export function progressWords(p: EventProgress): string {
  const n = prefixLength(p);
  if (n === 0) return 'before events';
  if (n === OW_EVENTS) return 'with every event passed';
  if (n > 0) return `after event ${hex2(n - 1)}`;
  const es = passedEvents(p);
  return es.length <= 4 ? `with event${es.length === 1 ? '' : 's'} ${es.map(hex2).join(', ')}` : `with ${es.length} of ${hex2(OW_EVENTS)} events`;
}

// the set with event e passed (on) or not, a new set
export function withEvent(p: EventProgress, e: number, on = true): EventSet {
  const b = eventBits(p);
  if (e >= 0 && e < OW_EVENTS) { if (on) b[e >> 3] |= 0x80 >> (e & 7); else b[e >> 3] &= ~(0x80 >> (e & 7)); }
  return b;
}
// the events below e not passed at the progress: where the map shown with e differs from the one e is stored against
// (the map before e in number order, CONTEXT.md "Event step")
export const missingBefore = (p: EventProgress, e: number): number[] =>
  Array.from({ length: Math.max(0, Math.min(e, OW_EVENTS)) }, (_, k) => k).filter((k) => !isPassed(p, k));
