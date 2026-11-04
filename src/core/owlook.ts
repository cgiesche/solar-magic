// The World check's Look group (worldcheck.ts): paths without a look (CONTEXT.md "Path without a look"). A walk or
// climb path tile the game shows nothing of – none of its 8x8s has a pixel in its submap's graphics – shows only by
// the map pieces under it on layer 2, so a path an event adds needs its look painted on layer 2 too. Two exact rules
// (0 hits on the clean game at every event progress; issue #366):
// - A, "path shown after Mario walks it": Mario reaches such a cell at an event progress before the first event
//   writing layer 2 under it (any of its four 8x8s) is passed;
// - B, "path without a look": an event's layer 1 changes make the cell such a path tile, no event up to and including
//   it writes layer 2 under it, and the map piece there after it is ground (on its region with every event passed
//   under cells without a path more often than under path cells). A cell A warns about gets no B.
// Paths on the map before events are not checked for B (the game's own have no look test that holds). An automatic
// look is not given: the game's looks can't be learned from the maps (the research in #366).

import type { Rom } from './rom.ts';
import { OW_EVENTS, OW_L1_TILES, MAP_NAMES, l1Index, l1XY, l2Index, owTileWords, readL2, owTileIndexes, type OverworldLoads, type OwRender } from './overworld.ts';
import { readEvents, eventPieces, drawPiece, pieceTiles, l2XY, eventRunners, eventTitle, submapOf, type Rect } from './owevents.ts';
import { hex2 } from './names.ts';
import type { Reached } from './owreach.ts';
import type { PathKind } from './owpaths.ts';
import type { ProgressMap } from './owprogress.ts';
import type { WorldProblem } from './worldcheck.ts';

const pixels = new Uint8Array(64);

// Whether a layer 1 tile has its own look: one of its 8x8s (Map16 words `words`) has a pixel in a load's graphics (from
// its BG1 character base, as drawOwMap draws it)
export function hasOwnLook(r: Pick<OwRender, 'vram' | 'ppuRegs'>, words: readonly number[]): boolean {
  return words.some((w) => owTileIndexes(r, 1, w, pixels).some((p) => p !== 0));
}

// Per submap (0 the main map, 1–6) per layer 1 tile 000–1FF: 1 when it has its own look in that submap's graphics
// (loaded at event progress 0), from the kept loads: found again only when the ROM edits changed what they read
export function l1OwnLooks(rom: Rom, loads: OverworldLoads): Uint8Array[] {
  return loads.derive('l1OwnLooks', (load) => {
    const words = Array.from({ length: OW_L1_TILES }, (_, t) => owTileWords(rom, t));
    return Array.from({ length: MAP_NAMES.length }, (_, k) => {
      const r = load(k, 0);
      return Uint8Array.from(words, (w) => (hasOwnLook(r, w) ? 1 : 0));
    });
  });
}

// what the rules look at
export interface LookInput {
  rom: Rom;
  maps: readonly ProgressMap[]; // layer 1, translevels and level flags at every event progress 0 … OW_EVENTS
  ownLooks: readonly Uint8Array[]; // l1OwnLooks
  kinds: readonly PathKind[];
  views: readonly Rect[]; // the submaps' views (submapViews)
  search: (progress: number) => Reached; // the search at an event progress (from maps; owprogress.ts progressSearches)
  place: (tile: number) => string;
}

// the four layer 2 entries (readL2 indexes) under a layer 1 cell
function l2Under(cell: number): number[] {
  const r = cell >> 10, { x, y } = l1XY(cell);
  return [l2Index(r, x * 2, y * 2), l2Index(r, x * 2 + 1, y * 2), l2Index(r, x * 2, y * 2 + 1), l2Index(r, x * 2 + 1, y * 2 + 1)];
}

// The Look group's path problems (rules A and B above)
export function lookProblems(inp: LookInput): WorldProblem[] {
  const { rom, maps, ownLooks, kinds, views, place } = inp, d = readEvents(rom), runners = eventRunners(rom);
  const submap = (c: number) => submapOf(views, c);
  // a walk or climb path tile without a look of its own
  const lookless = (c: number, t: number) => (kinds[t] === 'walk' || kinds[t] === 'climb') && !ownLooks[submap(c)]?.[t];
  // the cells shown: the main map's, a submap's inside its view (8x8 units, wrapping around the region)
  const shown = (c: number) => {
    if (c < 0x400) return true;
    const v = views[submap(c)], { x, y } = l1XY(c);
    return !!v && ((x * 2 - v.x) & 63) < v.w && ((y * 2 - v.y) & 63) < v.h;
  };
  const cells = Array.from({ length: 0x800 }, (_, c) => c).filter(shown);

  // the first event writing layer 2 under each cell (OW_EVENTS: none); the candidates of B with their blocks after
  // their event
  const firstL2 = new Uint8Array(0x800).fill(OW_EVENTS);
  const made = new Map<number, { event: number; block: number[] }>();
  const l2 = readL2(rom);
  for (let e = 0; e < OW_EVENTS; e++) {
    for (const p of eventPieces(d, e)) {
      drawPiece(l2, d, p);
      for (const i of pieceTiles(d, p)) {
        const { r, x, y } = l2XY(i), c = l1Index(r, x >> 1, y >> 1);
        if (firstL2[c] === OW_EVENTS) firstL2[c] = e;
      }
    }
    // (what the event's layer 1 changes, reveal and destroys change: the maps before and after it differ)
    const was = maps[e].l1, is = maps[e + 1].l1;
    for (const c of cells) {
      if (was[c] === is[c] || made.has(c) || !lookless(c, is[c]) || lookless(c, was[c])) continue;
      if (firstL2[c] > e) made.set(c, { event: e, block: l2Under(c).map((i) => l2[i]) });
    }
  }

  const out: WorldProblem[] = [];
  // A: the first progress Mario reaches a lookless path cell at whose look's event isn't passed there
  const lateAt = new Map<number, number>(), last = Math.max(-1, ...cells.filter((c) => firstL2[c] < OW_EVENTS).map((c) => firstL2[c]));
  for (let p = 0; p <= last; p++) {
    const l1 = maps[p].l1, open = cells.filter((c) => firstL2[c] >= p && firstL2[c] < OW_EVENTS && !lateAt.has(c) && lookless(c, l1[c]));
    if (!open.length) continue;
    const r = inp.search(p).r;
    for (const c of open) if (r.tiles[c]) lateAt.set(c, p);
  }
  for (const [c, p] of lateAt) {
    const e = firstL2[c], by = eventTitle(runners, e), when = p ? `after event ${hex2(p - 1)}` : 'before events';
    out.push({ key: `path-late-look:${c}`, group: 'look', severity: 'warn', tile: c, progress: p, show: { event: e, mode: 'l2' },
      text: `Path at ${place(c)} shown after Mario walks it: he gets there ${when}, its look comes with ${by} (event ${hex2(e)})`,
      brief: `path at ${place(c)} shown late`,
      title: `The path tile shows nothing itself: its look is the map pieces under it on layer 2, and the first event drawing there is ${hex2(e)}. Paint the look in an earlier event, or let the path come with event ${hex2(e)}. Show: event ${hex2(e)} in layer 2.` });
  }

  // B: ground under the new path – none of the four 8x8s of its block after the event is found under path cells at
  // least as often as under cells without one (on its region with every event passed, the new paths left out): no
  // piece of a path's look there
  if (made.size) {
    const all = maps[OW_EVENTS].l1, count = new Map<string, number>(); // (region:word → path − non-path)
    for (const c of cells) {
      if (made.has(c)) continue;
      const by = kinds[all[c]] === 'none' ? -1 : 1;
      for (const i of l2Under(c)) { const k = `${c >> 10}:${l2[i]}`; count.set(k, (count.get(k) ?? 0) + by); }
    }
    const pathWord = (c: number, w: number) => { const n = count.get(`${c >> 10}:${w}`); return n !== undefined && n >= 0; };
    for (const [c, { event: e, block }] of made) {
      if (lateAt.has(c) || block.some((w) => pathWord(c, w))) continue;
      const by = eventTitle(runners, e);
      out.push({ key: `path-no-look:${c}`, group: 'look', severity: 'warn', tile: c, progress: e + 1, show: { event: e, mode: 'l2' },
        text: `Path without a look at ${place(c)}: ${by} (event ${hex2(e)}) makes it a path, but no event up to it draws under it`,
        brief: `path without a look at ${place(c)}`,
        title: `The path tile shows nothing itself, and under it is the ground around it: the player doesn't see the path. Paint a map piece under it in event ${hex2(e)}'s layer 2 (Show).` });
    }
  }
  return out;
}
