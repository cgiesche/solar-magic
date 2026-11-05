// The World check's checks beyond the paths' problems (worldcheck.ts): events nothing runs, links Mario can't come
// back from, levels without level tile an exit leads into, events a loaded save draws in another order than they
// ran in play, and stars without a translevel of their own. Each a plain function of the ROM and the searches of owreach.ts with every event passed.

import type { Rom } from './rom.ts';
import { OW_EVENTS, MAX_TRANSLEVEL, translevelToLevel, readL1, readTranslevels, l1Index, isStarPipeTile } from './overworld.ts';
import { readEvents, eventChanges, eventRunners, eventPieces, drawPiece, l2XY, type EventData, type EventChanges, type EventRunner } from './owevents.ts';
import { reach, inputWithout, type Reach } from './owreach.ts';
import { starsWithoutTranslevel, isStar } from './owstars.ts';
import { readSecondaryEntrance, mainTranslevel, OW_NORMAL, OW_SECRET } from './level.ts';
import type { ExitGraph } from './exitgraph.ts';
import { hex2, hex3 } from './names.ts';
import type { CheckedAt, WorldProblem } from './worldcheck.ts';

const SECONDARY_ENTRANCES = 0x200;

// the layer 1 tile (l1Index) a layer 2 tilemap entry (readL2 index) is on
const l2Tile = (i: number): number => { const { r, x, y } = l2XY(i); return l1Index(r, x >> 1, y >> 1); };
// the first tile an event changes (l1Index), -1: none
const firstTile = (c: EventChanges): number => c.l1[0] ?? (c.l2.length ? l2Tile(c.l2[0]) : -1);

// what the checks share: the ROM's events read once
export interface CheckContext {
  rom: Rom;
  all: CheckedAt; // the search with every event passed
  place: (tile: number) => string;
  events: EventData;
  changes: EventChanges[]; // per event
  runners: Map<number, EventRunner[]>; // the level exits running each event (eventRunners)
}
export function checkContext(rom: Rom, all: CheckedAt, place: (tile: number) => string): CheckContext {
  const events = readEvents(rom);
  const of = eventChanges(rom, events);
  return { rom, all, place, events, changes: Array.from({ length: OW_EVENTS }, (_, e) => of(e)), runners: eventRunners(rom) };
}

// ---- events never run ----

// The events that change the map (layer 1 or 2) but that no level exit runs – owevents.ts eventRunners: a level's
// normal exit, a secret exit only where the level can have it – and no entrance to the overworld with its own event
// (normal exit: the event, secret exit: + 1)
export function eventsNeverRun(c: CheckContext): WorldProblem[] {
  const { rom } = c, run = new Set(c.runners.keys());
  for (let i = 0; i < SECONDARY_ENTRANCES; i++) {
    const o = readSecondaryEntrance(rom, i).overworld;
    if (o?.ownEvent && (o.action === OW_NORMAL || o.action === OW_SECRET)) run.add(o.event + (o.action === OW_SECRET ? 1 : 0));
  }
  const out: WorldProblem[] = [];
  for (let e = 0; e < OW_EVENTS; e++) {
    const tile = run.has(e) ? -1 : firstTile(c.changes[e]);
    if (tile < 0) continue;
    out.push({ key: `event-never-run:${e}`, group: 'progress', severity: 'warn', tile, progress: e + 1,
      text: `Event ${hex2(e)} changes the map, but no level exit or teleport runs it`, brief: `event ${hex2(e)} never run`,
      title: 'No level with a level tile runs it (its base event, or + 1–3 for a secret exit it has), nor an exit to the overworld with its own event. The hack\'s own code may run it.' });
  }
  return out;
}

// ---- stars without a translevel ----

// The stars (owstars.ts) at any event progress that hold no translevel – a hack's, or one painted before the editor
// gave stars one: Mario walks off them only in the ways translevel 0's flags open, shared with every tile without
// one, and the status bar shows its blank name. Found at progress 0 when the star is on the map before events.
export function starsWithoutTranslevelProblems(c: CheckContext): WorldProblem[] {
  const l1 = readL1(c.rom);
  return starsWithoutTranslevel(c.rom).map((i) => ({
    key: `star-no-translevel:${i}`, group: 'paths', severity: 'warn', tile: i, progress: isStar(l1[i]) ? 0 : OW_EVENTS,
    text: `Star at ${c.place(i)} has no translevel of its own`, brief: `star without translevel at ${c.place(i)}`,
    title: 'Mario walks off it only in the ways translevel 00\'s flags open – shared with every tile without one – and the status bar shows a blank name. Select it in the layer 1 mode (Alt+click) and give it a translevel.',
  }));
}

// ---- stranded by a link ----

// The stars, pipes and exit paths Mario takes (every event passed) to where no way leads back to where he took them
export function stranded(c: CheckContext): WorldProblem[] {
  const { all: { inp, r }, place } = c;
  const searched = new Map<number, Reach>();
  const from = (s: number) => searched.get(s) ?? searched.set(s, reach({ ...inp, start: s })).get(s)!;
  // each link: where Mario takes it (`at`: the star/pipe, the exit path tile), the stop he takes it from and comes to
  const links: { at: number; from: number; to: number; what: string }[] = [];
  for (const [k, w] of r.walks) {
    const at = w.to < 0 ? undefined : w.path.find((i) => inp.kinds[inp.l1[i]] === 'exit');
    if (at !== undefined) links.push({ at, from: k >> 2, to: w.to, what: 'exit path tile' });
  }
  for (const s of r.stops) {
    if (!isStarPipeTile(inp.l1[s])) continue;
    for (const to of inp.stars.get(s) ?? []) links.push({ at: s, from: s, to, what: 'star or pipe' });
  }
  const out: WorldProblem[] = [], keys = new Set<string>();
  for (const l of links) {
    const key = `stranded:${l.at}:${l.to}`;
    if (keys.has(key) || l.to === l.from || from(l.to).stops.has(l.from)) continue;
    keys.add(key);
    out.push({ key, group: 'links', severity: 'error', tile: l.at, progress: OW_EVENTS,
      text: `Stranded: the ${l.what} at ${place(l.at)} takes Mario to ${place(l.to)}, from where no way leads back`,
      brief: `stranded at ${place(l.to)}`,
      title: `Not even with every event passed does a path, star, pipe or exit path lead from ${place(l.to)} back to ${place(l.from)}: what he left behind there is lost to him.` });
  }
  return out;
}

// ---- levels without level tile an exit leads into ----

// The translevels no level tile on any map enters (the overworld editor's "Without level tile") whose level another level's
// exit leads into: shown at the level tile of the level the exit is in (-1: none)
export function untiledLevelsEntered(c: CheckContext, graph: ExitGraph): WorldProblem[] {
  const { rom, place } = c, tls = readTranslevels(rom), tileOf = new Map<number, number>();
  tls.forEach((tl, i) => { if (tl && !tileOf.has(tl)) tileOf.set(tl, i); });
  const out: WorldProblem[] = [];
  for (let tl = 1; tl <= MAX_TRANSLEVEL; tl++) {
    if (tileOf.has(tl)) continue;
    const level = translevelToLevel(tl), into = graph.exitsInto(level).filter((e) => !e.overworld && e.from !== level);
    if (!into.length) continue;
    const by = into[0].from, parent = graph.parentOf(by), ptl = parent === null ? null : mainTranslevel(parent);
    const tile = ptl ? tileOf.get(ptl) ?? -1 : -1;
    out.push({ key: `untiled-level:${level}`, group: 'progress', severity: 'warn', tile, progress: OW_EVENTS,
      text: `Level ${hex3(level)} has no level tile, but an exit of level ${hex3(by)} leads into it`, brief: `level ${hex3(level)} without level tile`,
      title: `Players get there only through ${into.length > 1 ? `${into.length} exits` : 'that exit'}${tile >= 0 ? ` (from the level tile at ${place(tile)})` : ''}. Fine if it is meant as part of that level; a level of its own on the map needs a level tile (layer 1: "Levels" in the picker).` });
  }
  return out;
}

// ---- event order ----

// Per event B, the events B is needed for (directly): those whose level tile Mario reaches with every event passed but
// not without B – without its layer 1 changes (the map before events there) and the way its level's exit opens (the
// level flags' direction, unless open from the start or another exit of the level opens it too)
export function eventsNeeded(c: CheckContext): number[][] {
  const { rom, all: { inp, r }, runners } = c, before = readL1(rom);
  const tileOf = (e: number) => runners.get(e)?.[0]?.tile ?? -1;
  return Array.from({ length: OW_EVENTS }, (_, b) => {
    const ch = c.changes[b], by = runners.get(b) ?? [];
    if (!ch.l1.length && !by.length) return [];
    const without = reach(inputWithout(rom, inp, ch, by, before));
    return [...runners.keys()].filter((a) => { const t = tileOf(a); return a !== b && r.stops.has(t) && !without.stops.has(t); });
  });
}

// Events that run in play in another order than their numbers, changing the same place to different tiles: event B
// runs before event A in play when B is needed for A, or for an event needed for A (eventsNeeded – an order every
// play keeps: where either of two events opens the way, neither is needed and nothing is said; an event's level is
// the first that runs it). A loaded save draws
// the events in number order (A, then B): where both change a tile the player saw A's change last, the save shows B's.
export function eventOrderProblems(c: CheckContext, needed = eventsNeeded(c)): WorldProblem[] {
  const { place, events: d } = c;
  const changes = c.changes;
  // what each event writes where: layer 1 tiles (silent) and layer 2 entries (its pieces), by place
  const written = new Map<number, { l1: Map<number, number>; l2: Map<number, number> }>();
  const writes = (e: number) => {
    const known = written.get(e);
    if (known) return known;
    // (a tile it reveals or destroys is left out: what it becomes there is the game's to work out, and two events
    // revealing one tile make it the same)
    const l1 = new Map(d.silent[e].filter((s) => s.layer === 1).map((s) => [s.loc, s.tile]));
    const l2 = new Uint16Array(0x2000);
    for (const p of eventPieces(d, e)) drawPiece(l2, d, p);
    const w = { l1, l2: new Map(changes[e].l2.map((i) => [i, l2[i]])) };
    written.set(e, w);
    return w;
  };
  const out: WorldProblem[] = [];
  for (let b = 0; b < OW_EVENTS; b++) {
    // the events B runs before in play (needed for, and what those are needed for)
    const after = new Set<number>(), queue = [...needed[b]];
    while (queue.length) { const a = queue.pop()!; if (!after.has(a)) { after.add(a); queue.push(...needed[a]); } }
    for (const a of [...after].filter((a) => a < b).sort((x, y) => x - y)) {
      const wa = writes(a), wb = writes(b);
      const l1 = [...wa.l1].find(([i, t]) => wb.l1.has(i) && wb.l1.get(i) !== t)?.[0];
      const l2 = l1 === undefined ? [...wa.l2].find(([i, t]) => wb.l2.has(i) && wb.l2.get(i) !== t)?.[0] : undefined;
      const tile = l1 ?? (l2 === undefined ? -1 : l2Tile(l2));
      if (tile < 0) continue;
      out.push({ key: `event-order:${a}:${b}`, group: 'look', severity: 'warn', tile, progress: b + 1,
        text: `${place(tile)} looks different after loading a save: in play event ${hex2(b)} runs before event ${hex2(a)}, a loaded save draws ${hex2(a)} first`,
        brief: `event ${hex2(a)} and ${hex2(b)} out of order`,
        title: `Event ${hex2(b)} opens the way to event ${hex2(a)}'s level, so the player sees ${hex2(a)}'s change there last; a loaded save draws the events in number order and shows ${hex2(b)}'s. Shown as a loaded save draws it.` });
    }
  }
  return out;
}
