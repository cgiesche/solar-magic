// Layer 2 event steps (ADR 0005, CONTEXT.md "Event step"), in Lunar Magic's formats. An event changes layer 2 in
// pieces of 8x8 tiles: a 6x6 or 2x2 block of the event tile storage written at a position of the layer 2 tilemap
// ($7F4000, 2 bytes per tile; the game's $04E4A9). Its standard steps are shown one after the other with the
// path fade ($04E6F9, on the submap Mario is on), its silent ones written at once when it ends ($04E9EC).
//
// - steps: 4 bytes each, the piece's storage index and its tilemap position ($04DD8D; Lunar Magic moves the table
//   to free space, its pointer the operands at $04E49F/$04E709/$04EE5A, + 2 at $04E4A4/$04E710/$04EE3F); an
//   event's steps are those from its divider to the next one's ($04E359, 0x79 words)
// - the storage: tile numbers ($0C8000; Lunar Magic's pointer at $04E4B0/$04E4BB and $04EAF5) and their
//   YXPCCCTT (LC_RLE1 from $0C8D00 to $7F0000 when the overworld loads; pointer $04DD45/$04DD4A); an index below
//   the 6x6 area ($0900, the operands at $04E4C0, $04E745, $04EAD8, $04EE5E) is a 6x6 piece, above it 2x2
// - silent steps: the game's 0x2C entries ($04E8E4 event, $04E910 layer, $04E93C position, $04E994 tile), Lunar
//   Magic's silent event hack (a JSL at $04E9F7) with a divider per event like the steps': read3(read3($04E9F8)
//   + $0D) dividers (byte offsets), + $22 the tiles (16-bit: a storage index on layer 2, a Map16 tile on layer 1),
//   + $28 the positions ($7F4000 / $7EC800), + $34 the layers (1 byte, 1 layer 2); a JSL at $04DCA5 writes the
//   layer 2 ones of each passed event when a file is loaded, after its standard steps, as Ankouno's
//   OverworldTables.asm and SMW Central's hijack map describe it and Lunar Magic's code in the ROMs it saved does.
//
// The patch (installEventPatch) brings the clean game into that layout: steps, storage and silent steps in free
// space, the silent event hook, 0x78 events (the loops at $04D859 and $04DCAA, the reveal tables moved and
// extended, $04DA74 …). The editor's code is its own; its table operands are where Lunar Magic's are.

import { snesToPc, Rom } from './rom.ts';
import { assemble } from './asar.ts';
import { rleEncode } from './rle.ts';
import { missingPatch } from './patches.ts';
import {
  OW_EVENTS, OverworldEmulator, type OverworldLoads, gameL1, readL1, readTranslevels, baseEvent, translevelToLevel, l1XY, revealAt, revealEventCount, readDestroyList,
  destroyEffects, destroyChanges, l1Index,
} from './overworld.ts';
import { RAM, getS16 } from './ram.ts';
import { record, countReads } from './romdeps.ts';
import type { Job } from './jobrunner.ts';

const DIVIDERS = 0x04e359, DIVIDER_WORDS = 0x79; // words: the first step of each event, the end
const STEP_OPS = [0x04e49f, 0x04e709, 0x04ee5a], STEP_OPS2 = [0x04e4a4, 0x04e710, 0x04ee3f];
const TILE_BANK = 0x04e4b0, TILE_LO = 0x04e4bb, TILE_LONG = 0x04eaf5;
const PROP_LO = 0x04dd45, PROP_BANK = 0x04dd4a;
const AREA6_OPS = [0x04e4c0, 0x04e745, 0x04ead8, 0x04ee5e];
const SILENT_HOOK = 0x04e9f7, LOAD_HOOK = 0x04dca5, LOAD_COUNT = 0x04dcaa, TL_COUNT = 0x04d859;
const SILENT_DIV = 0x0d, SILENT_TILES = 0x22, SILENT_LOCS = 0x28, SILENT_LAYERS = 0x34;
const GAME_SILENT = { events: 0x04e8e4, layers: 0x04e910, locs: 0x04e93c, tiles: 0x04e994, count: 0x2c };
// the reveal tables (per event: the layer 1 tile, its VRAM address), 0x70 entries in the game
const REVEAL_OPS = [0x04da74, 0x04ec8c, 0x04ecba, 0x04ecc5, 0x04ed97, 0x04edbe], REVEAL_VRAM_OP = 0x04edb8;
const GAME_REVEAL = 0x04d85d, GAME_REVEAL_VRAM = 0x04d93d, GAME_REVEALS = 0x70;
// the game's code and tables the patch changes (SNES address, length), Lunar Magic's hijack: the hooks, the event
// counts, the dividers and the operands pointing to the moved tables; a third-party patch may not change it (patchapply.ts)
export const EVENT_HOOKS: [number, number][] = [
  [SILENT_HOOK, 5], [LOAD_HOOK, 4], [LOAD_COUNT, 1], [TL_COUNT, 1], [DIVIDERS, DIVIDER_WORDS * 2],
  ...[...STEP_OPS, ...STEP_OPS2, TILE_LONG, ...REVEAL_OPS, REVEAL_VRAM_OP].map((a): [number, number] => [a, 3]),
  [TILE_BANK, 1], [TILE_LO, 2], [PROP_LO, 2], [PROP_BANK, 1], ...AREA6_OPS.map((a): [number, number] => [a, 2]),
];

// the event tile storage's limit: its YXPCCCTT go to $7F0000, below the level heights patch's RAM at $7F3666
export const STORAGE_MAX = 0x3600;
export const PIECE6 = 36, PIECE2 = 4;
const STEP_SLACK = 0x100, STORAGE_SLACK = 0x200, SILENT_SLACK = 0x40; // room for later edits in each block

// a piece of an event: its storage index and its tilemap position (a byte offset of $7F4000)
export interface Piece { at: number; pos: number }
// a silent step: on layer 2 a piece (tile its storage index), on layer 1 a Map16 tile at an offset of $7EC800
export interface Silent { layer: 1 | 2; tile: number; loc: number }
export interface EventData {
  area6: number; // storage indexes below it are 6x6 pieces
  storage: Uint16Array; // tile words (tile number, YXPCCCTT)
  steps: Piece[][]; // per event, in order
  silent: Silent[][]; // per event, in the order the game writes them
}

export const hasEventPatch = (rom: Rom): boolean => rom.r8(SILENT_HOOK) === 0x22;
const silentCode = (rom: Rom) => rom.r24(SILENT_HOOK + 1);
export const isBig = (d: { area6: number }, at: number): boolean => at < d.area6;

// the layer 2 tiles (indexes of readL2's map) a piece at `pos` writes, in storage order: rows of 6 or 2 tiles,
// crossing into the next tilemap quadrant (32x32 tiles) as the game's $04E4D0/$04E520 do; a tile outside the
// tilemap is left out (-1)
export function pieceCells(pos: number, big: boolean): number[] {
  const n = big ? 6 : 2, out: number[] = [];
  let row = pos;
  for (let r = 0; r < n; r++) {
    let x = row;
    for (let c = 0; c < n; c++) {
      out.push(x < 0x4000 ? x >> 1 : -1);
      x = (x + 2) & 0xffff;
      if ((x & 0x3f) === 0) x = (((x - 1) & 0xffc0) + 0x800) & 0xffff;
    }
    const next = (row + 0x40) & 0xffff;
    row = next & 0x7c0 ? next : ((row & 0xf83f) + 0x1000) & 0xffff;
  }
  return out;
}

// LC_RLE1 as the game's $04DD57: a control byte n, bit 7 set: the next byte (n & $7F) + 1 times, else n + 1 bytes;
// a word $FFFF where a control byte would be ends it
function rle1Decode(rom: Rom, at: number): number[] {
  const d = rom.data, out: number[] = [];
  let p = snesToPc(at);
  while (p + 1 < d.length && !(d[p] === 0xff && d[p + 1] === 0xff)) {
    const c = d[p++];
    if (c & 0x80) { const v = d[p++]; for (let i = 0; i <= (c & 0x7f); i++) out.push(v); }
    else for (let i = 0; i <= c; i++) out.push(d[p++]);
  }
  rom.noteRead(snesToPc(at), Math.min(d.length, p + 2) - snesToPc(at)); // (with the end mark)
  return out;
}
const rle1Encode = (v: number[]) => Uint8Array.from([...rleEncode(v, true), 0xff, 0xff]);

const stepTable = (rom: Rom) => rom.r24(STEP_OPS[0]);
const tileTable = (rom: Rom) => (rom.r8(TILE_BANK) << 16) | rom.r16(TILE_LO);
const propTable = (rom: Rom) => (rom.r8(PROP_BANK) << 16) | rom.r16(PROP_LO);

export function readEvents(rom: Rom): EventData {
  const area6 = rom.r16(AREA6_OPS[0]);
  const props = rle1Decode(rom, propTable(rom)), tiles = tileTable(rom);
  const storage = Uint16Array.from(props, (p, k) => rom.r8(tiles + k) | (p << 8));
  const steps: Piece[][] = [], table = stepTable(rom);
  for (let e = 0; e < OW_EVENTS; e++) {
    const from = rom.r16(DIVIDERS + e * 2), to = rom.r16(DIVIDERS + e * 2 + 2);
    steps.push(Array.from({ length: Math.max(0, to - from) }, (_, k) => ({ at: rom.r16(table + (from + k) * 4), pos: rom.r16(table + (from + k) * 4 + 2) })));
  }
  const silent: Silent[][] = Array.from({ length: OW_EVENTS }, () => []);
  if (hasEventPatch(rom)) {
    const c = silentCode(rom), div = rom.r24(c + SILENT_DIV), t = rom.r24(c + SILENT_TILES), l = rom.r24(c + SILENT_LOCS), y = rom.r24(c + SILENT_LAYERS);
    for (let e = 0; e < OW_EVENTS; e++) {
      for (let x = rom.r16(div + e * 2); x < rom.r16(div + e * 2 + 2); x += 2) {
        silent[e].push({ layer: rom.r8(y + x / 2) & 1 ? 2 : 1, tile: rom.r16(t + x), loc: rom.r16(l + x) });
      }
    }
  } else {
    // the game looks its table through from the last entry down
    const g = GAME_SILENT;
    for (let k = g.count - 1; k >= 0; k--) {
      const e = rom.r8(g.events + k);
      if (e < OW_EVENTS) silent[e].push({ layer: rom.r8(g.layers + k) & 1 ? 2 : 1, tile: rom.r16(g.tiles + k * 2), loc: rom.r16(g.locs + k * 2) });
    }
  }
  return { area6, storage, steps, silent };
}

// writes piece p into the layer 2 map (readL2's layout)
export function drawPiece(l2: Uint16Array, d: EventData, p: Piece): void {
  pieceCells(p.pos, isBig(d, p.at)).forEach((i, k) => { if (i >= 0) l2[i] = d.storage[p.at + k] ?? 0; });
}
// the layer 2 pieces event e writes, in order: its steps, then its silent ones
export const eventPieces = (d: EventData, e: number): Piece[] =>
  [...d.steps[e], ...d.silent[e].filter((s) => s.layer === 2).map((s) => ({ at: s.tile, pos: s.loc }))];
// layer 2 as after events from … to-1 passed, in their number order, as the game draws them when a file is loaded
export function applyEvents(l2: Uint16Array, d: EventData, from: number, to: number): Uint16Array {
  const out = l2.slice();
  for (let e = from; e < to; e++) for (const p of eventPieces(d, e)) drawPiece(out, d, p);
  return out;
}

// ---- painting an event: the map after it, its steps found ----

// where an event is shown, per region (0 the main map, 1 the submaps): `view` the part of the region (8x8 tiles) the
// game shows when it runs there, null none (its steps there are silent); `from` the tile the path starts at (the
// level tile running it), null none
export interface Rect { x: number; y: number; w: number; h: number }
export interface EventPlace { views: (Rect | null)[]; from: { region: number; x: number; y: number } | null }

const W = 64; // tiles per row of a region
// a layer 2 tile's region and position (readL2 index; l2Index's inverse)
export const l2XY = (i: number): { r: number; x: number; y: number } => { const r = i >> 12, k = i & 0xfff, q = k >> 10; return { r, x: (q & 1) * 32 + (k & 31), y: (q >> 1) * 32 + ((k >> 5) & 31) }; };
const cellAt = (r: number, x: number, y: number) => (r << 12) | (((y >> 5) * 2 + (x >> 5)) << 10) | ((y & 31) << 5) | (x & 31);
const inRect = (v: Rect, x: number, y: number) => x >= v.x && y >= v.y && x < v.x + v.w && y < v.y + v.h;

// the storage places pieces use (other than `skip`'s), as a set of indexes
function usedStorage(d: EventData, skip: number): Uint8Array {
  const used = new Uint8Array(STORAGE_MAX);
  d.steps.forEach((s, e) => { if (e !== skip) for (const p of eventPieces(d, e)) used.fill(1, p.at, p.at + (isBig(d, p.at) ? PIECE6 : PIECE2)); });
  return used;
}

// The changes of `after` (the map as it is to look after event e) to the map before it (events 0 … e-1 in number
// order), as pieces: 6x6 where one covers at least a third changed tiles and no tile another event writes, else
// 2x2 (the fewest such tiles); each placed in the storage where the same tiles are, else in free places (6x6
// below the 6x6 area, 2x2 above it). A piece in its region's view is a step, shown in order along the path from
// `from` (reversed: towards it; undefined: as the event's steps were) – those the event had in the order they had –,
// else silent. Layer 1 silent steps stay.
export function paintEvent(d: EventData, base: Uint16Array, e: number, after: Uint16Array, place: EventPlace, reversed?: boolean): EventData {
  const before = applyEvents(base, d, 0, e);
  const changed = new Uint8Array(0x2000);
  for (let i = 0; i < 0x2000; i++) if (after[i] !== before[i]) changed[i] = 1;
  // tiles another event writes
  const others = new Uint8Array(0x2000);
  d.steps.forEach((_, k) => { if (k !== e) for (const p of eventPieces(d, k)) for (const i of pieceCells(p.pos, isBig(d, p.at))) if (i >= 0) others[i] = 1; });
  if (reversed === undefined) reversed = isReversed(d.steps[e], d, place);
  const used = usedStorage(d, e);
  const storage = Array.from(d.storage);
  const starts = new Map<string, number>(); // content → a storage index holding it
  const key = (big: boolean, words: number[]) => `${big ? 6 : 2}:${words.join(',')}`;
  d.steps.forEach((_, k) => {
    if (k === e) return;
    for (const p of eventPieces(d, k)) {
      const big = isBig(d, p.at), kk = key(big, storage.slice(p.at, p.at + (big ? PIECE6 : PIECE2)));
      if (!starts.has(kk)) starts.set(kk, p.at);
    }
  });
  const alloc = (big: boolean, words: number[]): number => {
    const kk = key(big, words), have = starts.get(kk);
    if (have !== undefined) return have;
    const n = big ? PIECE6 : PIECE2, lo = big ? 0 : d.area6, hi = big ? d.area6 : STORAGE_MAX;
    for (let k = lo; k + n <= hi; k++) {
      if (used.subarray(k, k + n).some((v) => v)) continue;
      while (storage.length < k + n) storage.push(0);
      storage.splice(k, n, ...words);
      used.fill(1, k, k + n);
      starts.set(kk, k);
      return k;
    }
    return -1;
  };
  const pieces: { at: number; pos: number; cells: number[] }[] = [];
  const left = changed.slice();
  const take = (r: number, x: number, y: number, n: number): boolean => {
    const cells: number[] = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) cells.push(cellAt(r, x + dx, y + dy));
    const at = alloc(n === 6, cells.map((i) => after[i]));
    if (at < 0) return false;
    for (const i of cells) left[i] = 0;
    pieces.push({ at, pos: cellAt(r, x, y) * 2, cells });
    return true;
  };
  for (let r = 0; r < 2; r++) {
    // 6x6: the window with the most changed tiles left, while it has a third of its tiles to change
    const full = new Set<string>();
    for (;;) {
      let best = 0, bx = 0, by = 0;
      for (let y = 0; y + 6 <= W; y++) for (let x = 0; x + 6 <= W; x++) {
        if (full.has(`${x},${y}`)) continue;
        let n = 0, bad = false;
        for (let dy = 0; dy < 6 && !bad; dy++) for (let dx = 0; dx < 6; dx++) {
          const i = cellAt(r, x + dx, y + dy);
          if (left[i]) n++;
          else if (!changed[i] && others[i]) { bad = true; break; }
        }
        if (!bad && n > best) { best = n; bx = x; by = y; }
      }
      if (best < PIECE6 / 3) break;
      if (!take(r, bx, by, 6)) { full.add(`${bx},${by}`); if (full.size > 64) break; }
    }
    // 2x2 for the rest: the most changed tiles left, then the fewest tiles of other events
    for (;;) {
      let best = -1, bx = 0, by = 0;
      for (let y = 0; y + 2 <= W; y++) for (let x = 0; x + 2 <= W; x++) {
        let n = 0, o = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const i = cellAt(r, x + dx, y + dy);
          if (left[i]) n++;
          else if (!changed[i] && others[i]) o++;
        }
        const score = n ? n * 8 - o : -1;
        if (score > best) { best = score; bx = x; by = y; }
      }
      if (best < 0) break;
      if (!take(r, bx, by, 2)) throw new Error(`The event storage is full (${STORAGE_MAX} places)`);
    }
  }
  // steps in the view, in order along the path; the rest silent
  const shown = pieces.filter((p) => {
    const c = l2XY(p.cells[0]), v = place.views[c.r], n = Math.sqrt(p.cells.length) / 2;
    return v !== null && v !== undefined && inRect(v, c.x + n, c.y + n);
  });
  const steps = pathOrder(shown.map((p) => p.cells.filter((i) => changed[i])), place).map((k) => shown[k]);
  if (reversed) steps.reverse();
  // steps the event had keep their order among each other (the user's), new ones take their places along the path
  const was = (p: { pos: number; cells: number[] }) => d.steps[e].findIndex((o) => o.pos === p.pos && isBig(d, o.at) === (p.cells.length === PIECE6));
  const kept = steps.filter((p) => was(p) >= 0).sort((a, b) => was(a) - was(b));
  for (let k = 0, j = 0; k < steps.length; k++) if (was(steps[k]) >= 0) steps[k] = kept[j++];
  const out: EventData = { area6: d.area6, storage: Uint16Array.from(storage), steps: d.steps.slice(), silent: d.silent.slice() };
  out.steps[e] = steps.map((p) => ({ at: p.at, pos: p.pos }));
  out.silent[e] = [...d.silent[e].filter((s) => s.layer === 1), ...pieces.filter((p) => !shown.includes(p)).map((p) => ({ layer: 2 as const, tile: p.at, loc: p.pos }))];
  return trimStorage(out);
}

// Event e's layer 1 changes (Lunar Magic's layer 1 event editor: silent steps, VRAM not refreshed – for other
// submaps and invisible tiles): the tiles where `after` (layer 1 as it is to look after the event) differs from
// `without` (as after it without them, layer1Without) – a step kept where its tile stays, new ones at the end in
// tile order (a step writes the tile's high byte too, $7FC800). A step writing the tile already there is kept unless `painted` (the tiles painted) has it: when
// events pass in another order than their numbers it may not be. Its layer 2 steps stay.
export function paintEventL1(d: EventData, e: number, after: ArrayLike<number>, without: ArrayLike<number>, painted: ReadonlySet<number> = new Set()): EventData {
  const keep = (s: Silent) => s.layer === 2 || (s.loc < 0x800 && s.tile === after[s.loc] && (after[s.loc] !== without[s.loc] || !painted.has(s.loc)));
  const kept = d.silent[e].filter(keep), have = new Set(kept.filter((s) => s.layer === 1).map((s) => s.loc)), added: Silent[] = [];
  for (let i = 0; i < 0x800; i++) if (after[i] !== without[i] && !have.has(i)) added.push({ layer: 1, tile: after[i], loc: i });
  const silent = d.silent.slice();
  silent[e] = [...kept, ...added];
  return { ...d, silent };
}
// layer 1 as after events 0 … e passed without event e's layer 1 changes (emulated, on a copy of the ROM)
export function layer1Without(rom: Rom, e: number): Uint16Array {
  return new EventL1Copy().without(rom, e);
}
// layer1Without on a copy of the ROM kept between calls (taking the ROM's bytes each time): its emulator keeps the
// title screen snapshot while the ROM bytes read on the way to the title screen are unchanged. What the copy's events and load read counts as read from the
// ROM (its recorders: a result kept by them goes when the ROM's events or what the load read change)
export class EventL1Copy {
  private copy: { rom: Rom; emu: OverworldEmulator } | null = null;
  without(rom: Rom, e: number): Uint16Array {
    let c = this.copy;
    if (c && c.rom.data.length === rom.data.length) c.rom.data = rom.data.slice();
    else { const copy = new Rom(rom.data); c = this.copy = { rom: copy, emu: new OverworldEmulator(copy) }; }
    const edit = record(c.rom, () => {
      const d = readEvents(c.rom), silent = d.silent.slice();
      silent[e] = silent[e].filter((s) => s.layer === 2);
      writeEvents(c.rom, { ...d, silent });
    }, { counted: false });
    const { result, reads } = c.emu.loadRecorded(0, e + 1);
    countReads(rom, null, edit.reads);
    countReads(rom, null, reads);
    return gameL1(result).slice();
  }
}
// layer1Without as a job of the result learner (probe worker: the overworld view asks for it while an event is
// painted), on the learner's kept copy. One step
export function* layer1WithoutJob(copy: EventL1Copy, rom: Rom, e: number): Job<Uint16Array> {
  return copy.without(rom, e);
}
// the layer 1 tiles (l1Index) event e changes
export const eventL1Tiles = (d: EventData, e: number): number[] => d.silent[e].filter((s) => s.layer === 1).map((s) => s.loc);

// the storage without the places no piece uses at its end (not below the 6x6 area)
function trimStorage(d: EventData): EventData {
  const used = usedStorage(d, -1);
  let end = d.storage.length;
  while (end > d.area6 && !used[end - 1]) end--;
  return end === d.storage.length ? d : { ...d, storage: d.storage.slice(0, end) };
}

// the order of pieces (their changed tiles) along the path: by the steps it takes from the tile nearest `from` over
// changed tiles (8 ways), each further part of the path from its tile nearest to it, after the parts before
function pathOrder(pieces: number[][], place: EventPlace): number[] {
  const cells = new Set(pieces.flat()), dist = new Map<number, number>();
  const src = place.from;
  const far = (i: number) => { const c = l2XY(i); return src ? (c.r === src.region ? Math.hypot(c.x - src.x, c.y - src.y) : 1e6) : c.y * W + c.x; };
  let base = 0;
  while (dist.size < cells.size) {
    const start = [...cells].filter((i) => !dist.has(i)).reduce((a, b) => (far(b) < far(a) ? b : a));
    const queue = [start];
    dist.set(start, base);
    let maxD = base;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], c = l2XY(i), di = dist.get(i)!;
      maxD = Math.max(maxD, di);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = c.x + dx, y = c.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= W) continue;
        const j = cellAt(c.r, x, y);
        if (cells.has(j) && !dist.has(j)) { dist.set(j, di + 1); queue.push(j); }
      }
    }
    base = maxD + 1;
  }
  const keyOf = (p: number[]) => (p.length ? Math.min(...p.map((i) => dist.get(i)!)) : Infinity);
  const tie = (p: number[]) => (p.length ? Math.min(...p.map(far)) : Infinity);
  return pieces.map((_, k) => k).sort((a, b) => keyOf(pieces[a]) - keyOf(pieces[b]) || tie(pieces[a]) - tie(pieces[b]));
}

// whether an event's steps run towards the path's start: the first is farther from it than the last
function isReversed(steps: Piece[], d: EventData, place: EventPlace): boolean {
  const src = place.from;
  if (!src || steps.length < 2) return false;
  const far = (p: Piece) => { const c = l2XY(p.pos >> 1), n = isBig(d, p.at) ? 3 : 1; return c.r === src.region ? Math.hypot(c.x + n - src.x, c.y + n - src.y) : 1e6; };
  return far(steps[0]) > far(steps[steps.length - 1]);
}

// ---- which level runs an event, where it is shown ----

// a level exit that runs an event: the translevel, the exit (0 normal, 1–3 the secret exits: the base event + it),
// a layer 1 tile entering the level (l1Index: the first the translevel table gives it, levelTileLevels)
export interface EventRunner { tl: number; exit: number; tile: number }
export function eventRunners(rom: Rom): Map<number, EventRunner[]> {
  const tls = readTranslevels(rom), out = new Map<number, EventRunner[]>();
  const tileOf = new Map<number, number>();
  tls.forEach((tl, i) => { if (tl && !tileOf.has(tl)) tileOf.set(tl, i); });
  for (const [tl, tile] of [...tileOf].sort((a, b) => a[0] - b[0])) {
    const b = baseEvent(rom, tl);
    for (let exit = 0; exit < 4 && b + exit < OW_EVENTS; exit++) (out.get(b + exit) ?? out.set(b + exit, []).get(b + exit)!).push({ tl, exit, tile });
  }
  // the normal exits first
  for (const l of out.values()) l.sort((a, b) => a.exit - b.exit || a.tl - b.tl);
  return out;
}
// What passing translevel tl changes on the overworld, per exit (0 normal, 1–3 the secret exits) whose event is the
// level's (no other level's normal exit runs it, as eventRunners orders them): the event, the layer 1 tiles (l1Index)
// it writes, reveals and destroys (with those destroying the tile on the map before events changes), the layer 2
// tilemap entries (readL2 indexes) its steps write.
export interface ExitChanges { exit: number; event: number; l1: number[]; l2: number[] }
export function exitChanges(rom: Rom, tl: number, d: EventData = readEvents(rom), runners = eventRunners(rom)): ExitChanges[] {
  const b = baseEvent(rom, tl), destroys = readDestroyList(rom), effects = destroyEffects(rom), map = readL1(rom), out: ExitChanges[] = [];
  for (let exit = 0; exit < 4 && b + exit < OW_EVENTS; exit++) {
    const e = b + exit, r = runners.get(e)?.[0];
    if (r?.tl !== tl || r.exit !== exit) continue;
    const reveal = e < revealEventCount(rom) ? revealAt(rom, e) : 0;
    const destroyed = destroys.filter((x) => x.event === e).flatMap((x) => [x.tile, ...destroyChanges(effects, map, x.tile).map((c) => c.cell)]);
    const l1 = new Set([...eventL1Tiles(d, e), ...(reveal ? [reveal] : []), ...destroyed]);
    out.push({ exit, event: e, l1: [...l1], l2: [...new Set(eventPieces(d, e).flatMap((p) => pieceTiles(d, p)))] });
  }
  return out;
}
const EXIT_SHORT = ['normal exit', 'secret exit 1', 'secret exit 2', 'secret exit 3'];
const hex3 = (n: number) => n.toString(16).toUpperCase().padStart(3, '0');
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
// "Level 105 · secret exit 1", "Event 4A" for one no level exit on the map runs
export function eventTitle(runners: Map<number, EventRunner[]>, e: number): string {
  const r = runners.get(e)?.[0];
  return r ? `Level ${hex3(translevelToLevel(r.tl))} · ${EXIT_SHORT[r.exit]}` : `Event ${hex2(e)}`;
}

// a level exit in the player's words: "Yoshi's Island 2 · secret exit" (name: the level's name by translevel)
const EXIT_WORDS = ['normal exit', 'secret exit', 'secret exit 2', 'secret exit 3'];
export const exitWords = (r: { tl: number; exit: number }, name: (tl: number) => string): string => `${name(r.tl)} · ${EXIT_WORDS[r.exit]}`;
// an event in the player's words: by the level exit running it (exitWords), one no level exit runs as "Event 4F (run
// by no level exit)"
export function eventWords(runners: Map<number, EventRunner[]>, e: number, name: (tl: number) => string): string {
  const r = runners.get(e)?.[0];
  return r ? exitWords(r, name) : `Event ${hex2(e)} (run by no level exit)`;
}

// The playthrough strip under the overworld map (CONTEXT.md "Event progress", ADR 0013): "Before events" (-1), then
// every event in number order – the order the game applies them loading a save –, each labelled in the player's
// words (eventWords) with the event's number apart (shown small after it; none for an event no level exit runs, its
// label has it). others: the further level exits running the event (the first one is the one passed at the progress)
export interface StripEntry { event: number; label: string; number: string; others: string[] }
export function playthroughStrip(runners: Map<number, EventRunner[]>, name: (tl: number) => string): StripEntry[] {
  return [{ event: -1, label: 'Before events', number: '', others: [] },
    ...Array.from({ length: OW_EVENTS }, (_, e) => {
      const more = runners.get(e)?.slice(1) ?? [];
      return { event: e, label: eventWords(runners, e, name), number: runners.has(e) ? hex2(e) : '', others: more.map((r) => exitWords(r, name)) };
    })];
}

// one event back (d -1) or further (+1) in number order from e (-1: the map before events), clamped
export function stepEvent(e: number, d: number): number {
  return Math.max(-1, Math.min(OW_EVENTS - 1, e + d));
}

// the part of the submaps' region each submap shows (8x8 tiles; the camera the game sets there, emulated), index
// 1–6; the main map scrolls over all of region 0. From the kept loads: emulated again only when the ROM edits
// changed what one read
export function submapViews(loads: OverworldLoads): Rect[] {
  return loads.derive('submapViews', (load) => Array.from({ length: 7 }, (_, k) => {
    if (!k) return { x: 0, y: 0, w: W, h: W };
    const w = load(k, 0).wram;
    return { x: Math.round(getS16(w, RAM.layer2X) / 8), y: Math.round(getS16(w, RAM.layer2Y) / 8), w: 32, h: 28 };
  }));
}
// submapViews as a job of the result learner (probe worker), one step (overworld.ts overworldMapJob)
export function* submapViewsJob(loads: OverworldLoads): Job<Rect[]> {
  return submapViews(loads);
}
// the submap a layer 1 tile is on: 0 on the main map, else the one whose view's center is nearest (as LevelEmulator's)
export function submapOf(views: Rect[], tile: number): number {
  if (tile < 0x400) return 0;
  const { x, y } = l1XY(tile), cx = x * 2 + 1, cy = y * 2 + 1;
  let best = 1, bd = Infinity;
  for (let k = 1; k < views.length; k++) {
    const v = views[k], d = Math.max(Math.abs(v.x + v.w / 2 - cx), Math.abs(v.y + v.h / 2 - cy));
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}
// where event e is shown: on the submap of the level tile running it (else `submap`, the one being edited), its
// path starting at that tile
export function eventPlace(runners: Map<number, EventRunner[]>, views: Rect[], e: number, submap: number): EventPlace {
  const r = runners.get(e)?.[0];
  const sub = r ? submapOf(views, r.tile) : submap;
  const from = r ? (() => { const { x, y } = l1XY(r.tile); return { region: r.tile >= 0x400 ? 1 : 0, x: x * 2 + 1, y: y * 2 + 1 }; })() : null;
  return { views: sub ? [null, views[sub]] : [views[0], null], from };
}

// event e's steps in the order `order` (indexes of its steps)
export function reorderSteps(d: EventData, e: number, order: number[]): EventData {
  const steps = d.steps.slice();
  steps[e] = order.map((k) => d.steps[e][k]);
  return { ...d, steps };
}

// the tiles (readL2 indexes) a step or silent step writes
export const pieceTiles = (d: EventData, p: Piece): number[] => pieceCells(p.pos, isBig(d, p.at)).filter((i) => i >= 0);

// ---- writing ----

// writes `data` into the block at `at` when it fits (a RATS block's size, or `room` bytes), else moves it to
// free space (with `slack` bytes of room) and returns the new address
function place(rom: Rom, at: number, data: Uint8Array, slack: number, room = -1): number {
  const pc = snesToPc(at), size = pc >= 0x80008 ? rom.isRatsAt(pc - 8) : -1;
  if (size >= data.length || (size < 0 && room >= data.length)) { rom.writeBytes(at, data); return at; }
  if (size >= 0) rom.freeAt(at);
  const payload = new Uint8Array(data.length + slack);
  payload.set(data);
  return rom.allocWrite(payload);
}
const words = (v: number[]) => Uint8Array.from(v.flatMap((w) => [w & 0xff, (w >> 8) & 0xff]));

// writes the steps, the storage and the silent steps (needs the patch); a table that didn't change keeps its bytes
export function writeEvents(rom: Rom, d: EventData): void {
  if (!hasEventPatch(rom)) missingPatch('Event steps (Lunar Magic format)');
  if (d.storage.length > STORAGE_MAX) throw new Error(`The event tiles need ${d.storage.length} of ${STORAGE_MAX} places`);
  const div: number[] = [0];
  for (const s of d.steps) div.push(div[div.length - 1] + s.length);
  rom.writeBytes(DIVIDERS, words(div));
  const steps = words(d.steps.flat().flatMap((p) => [p.at, p.pos]));
  const st = place(rom, stepTable(rom), steps, STEP_SLACK);
  STEP_OPS.forEach((a) => rom.w24(a, st));
  STEP_OPS2.forEach((a) => rom.w24(a, st + 2));
  const tiles = place(rom, tileTable(rom), Uint8Array.from(d.storage, (w) => w & 0xff), STORAGE_SLACK);
  rom.w8(TILE_BANK, tiles >> 16); rom.w16(TILE_LO, tiles & 0xffff); rom.w24(TILE_LONG, tiles);
  const props = place(rom, propTable(rom), rle1Encode(Array.from(d.storage, (w) => w >> 8)), STORAGE_SLACK);
  rom.w8(PROP_BANK, props >> 16); rom.w16(PROP_LO, props & 0xffff);
  AREA6_OPS.forEach((a) => rom.w16(a, d.area6));
  const c = silentCode(rom), all = d.silent.flat(), sdiv: number[] = [0];
  for (const s of d.silent) sdiv.push(sdiv[sdiv.length - 1] + s.length * 2);
  // a table never empty (an entry no event reaches, as Lunar Magic's)
  const pad = <T>(v: T[], none: T) => (v.length ? v : [none]);
  for (const [off, data] of [
    [SILENT_DIV, words(sdiv)],
    [SILENT_TILES, words(pad(all.map((s) => s.tile), 0))],
    [SILENT_LOCS, words(pad(all.map((s) => s.loc), 0))],
    [SILENT_LAYERS, Uint8Array.from(pad(all.map((s) => (s.layer === 2 ? 1 : 0)), 0))],
  ] as [number, Uint8Array][]) rom.w24(c + off, place(rom, rom.r24(c + off), data, SILENT_SLACK));
}

// the ROM bytes (PC offsets, [start, end)) of the event steps' tables
export function eventDataRanges(rom: Rom): [number, number][] {
  if (!hasEventPatch(rom)) return [];
  const block = (snes: number): [number, number] => { const pc = snesToPc(snes), n = rom.isRatsAt(pc - 8); return [pc, pc + Math.max(0, n)]; };
  const at = (snes: number, len: number): [number, number] => [snesToPc(snes), snesToPc(snes) + len];
  const c = silentCode(rom);
  return [
    at(DIVIDERS, (OW_EVENTS + 1) * 2), block(stepTable(rom)), block(tileTable(rom)), block(propTable(rom)),
    ...[SILENT_DIV, SILENT_TILES, SILENT_LOCS, SILENT_LAYERS].map((o) => block(rom.r24(c + o))),
    ...[...STEP_OPS, ...STEP_OPS2, TILE_LONG].map((a) => at(a, 3)), at(TILE_BANK, 1), at(TILE_LO, 2), at(PROP_LO, 2), at(PROP_BANK, 1),
    ...AREA6_OPS.map((a) => at(a, 2)), ...[SILENT_DIV, SILENT_TILES, SILENT_LOCS, SILENT_LAYERS].map((o) => at(c + o, 3)),
  ];
}

// ---- the patch ----
const hx = (n: number) => '$' + n.toString(16).toUpperCase();

const CODE_SIZE = 0x98;

const eventAsm = (code: number, t: { div: number; tiles: number; locs: number; layers: number }) => `lorom
; the silent steps of the event in A (8): from the game's $04E9F1 (when the overworld loads, $04DA49 – layer 1
; only, layer 2 is drawn with the file) and $04E9EC (an event ends); back at $04E9FC as after its loop
org ${hx(SILENT_HOOK)}
  JSL Silent : NOP
; a file loaded ($04DC6A): after an event's standard steps its silent ones, then the next event (A = $0F)
org ${hx(LOAD_HOOK)}
  JSL Load
org ${hx(LOAD_COUNT)}
  db ${hx(OW_EVENTS)}

org ${hx(code)}
Silent:
  PHP
  REP #$30
  PHY
  AND #$00FF : ASL : TAX
  LDY #$0004
- LDA.l ${hx(t.div)},x : STA $0002,y            ; $06 the event's first entry, $04 the next event's
  INX : INX : DEY : DEY : BNE -
  SEC : SBC $06 : BEQ .done
  TAY
  LDX $06
.next
  assert pc() == ${hx(code + SILENT_TILES - 1)}
  LDA.l ${hx(t.tiles)},x : STA $00
  assert pc() == ${hx(code + SILENT_LOCS - 1)}
  LDA.l ${hx(t.locs)},x : STA $04
  PHX
  TXA : LSR : TAX
  SEP #$20
  assert pc() == ${hx(code + SILENT_LAYERS - 1)}
  LDA.l ${hx(t.layers)},x : AND #$01 : BEQ .layer1
  LDA $09,s : CMP #$AB : BEQ .skip              ; called by $04DA49 ($04DAA9 JSR): the overworld loads
  PHY : PHP
  LDY $00
  PHK : PER .back-1 : PEA.w $8413               ; the game's piece ($04E4A9, Y the storage index, $04 the position), its RTS through an RTL
  JML $84E4A9
.back
  PLP : PLY
  BRA .skip
.layer1
  LDX $04
  LDA $00 : STA $7EC800,x
  LDA $01 : STA $7FC800,x
.skip
  REP #$20
  PLX : INX : INX
  DEY : DEY : BNE .next
.done
  PLY
  PLP
  RTL

Load:
  LDA $0F : AND #$07 : TAX
  LDA $0F : LSR #3 : TAY
  LDA $1F02,y : AND.l Bits,x : BEQ +
  LDA $0F : JSL Silent
+ INC $0F : LDA $0F
  RTL
Bits:
  db $80,$40,$20,$10,$08,$04,$02,$01
warnpc ${hx(code + CODE_SIZE)}
`;

// needs Asar (loadAsar) to be loaded; the clean game's steps, storage and silent steps in Lunar Magic's layout,
// and 0x78 events (the reveal tables extended with 8 that reveal nothing)
export function installEventPatch(rom: Rom): void {
  if (hasEventPatch(rom)) return;
  if (rom.r8(TL_COUNT - 1) !== 0xc9) throw new Error('The translevel table patch is needed first');
  const d = readEvents(rom);
  const reveal = rom.bytes(GAME_REVEAL, GAME_REVEALS * 2), vram = rom.bytes(GAME_REVEAL_VRAM, GAME_REVEALS * 2);
  const ext = (b: Uint8Array) => { const o = new Uint8Array(OW_EVENTS * 2); o.set(b); return o; };
  const revealAt = rom.allocWrite(ext(reveal)), vramAt = rom.allocWrite(ext(vram));
  REVEAL_OPS.forEach((a) => rom.w24(a, revealAt));
  rom.w24(REVEAL_VRAM_OP, vramAt);
  // the silent tables' first places (writeEvents moves them on), the code
  const one = () => rom.allocWrite(new Uint8Array(SILENT_SLACK));
  const t = { div: rom.allocWrite(new Uint8Array((OW_EVENTS + 1) * 2 + SILENT_SLACK)), tiles: one(), locs: one(), layers: one() };
  const code = rom.allocWrite(new Uint8Array(CODE_SIZE));
  const r = assemble(rom.data, new Map([['events.asm', eventAsm(code, t)]]), 'events.asm');
  if (!r.ok) throw new Error(r.errors.map((e) => e.message).join(' '));
  for (const [a, n] of [[SILENT_HOOK, 5], [LOAD_HOOK, 4], [LOAD_COUNT, 1], [code, CODE_SIZE]]) {
    rom.writeAt(snesToPc(a), r.rom.subarray(snesToPc(a), snesToPc(a) + n));
  }
  rom.w8(TL_COUNT, OW_EVENTS);
  writeEvents(rom, d);
}
