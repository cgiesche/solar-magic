// Stars (CONTEXT.md "Star", docs/research/star-tile-translevels.md): a star tile (5F) is a stop tile from which A takes
// Mario to another place (the star/pipe table). Its translevel is used as a stop tile's: its level flags ($1EA2) are the
// ways Mario walks off it, its name the status bar's while he stands there; it enters no level and runs no event
// (owevents.ts eventRunners). So a star keeps a translevel of its own as the path tool's stops do (owroute.ts): painted
// on a cell without one it takes a free one without name, base event or messages (stopTranslevels; of them the one
// bringing least along), its initial flags (every new game) the ways its paths open; painted over with another star or
// stop it keeps it; painted over with a path it frees it – unless the cell is a stop or level tile on another map (at
// another event progress), which the translevel table (per cell) holds it for. Pure on the ROM given: nothing drawn.

import type { Rom } from './rom.ts';
import { readTranslevels, writeTranslevels, resetTranslevel, MAX_TRANSLEVEL } from './overworld.ts';
import { cellsBecoming } from './owevents.ts';
import { heldElsewhere } from './owleveltiles.ts';
import { neighbor } from './owreach.ts';
import { tileWays, SHAPED_KINDS } from './owpathshape.ts';
import { stopTranslevels, takeStopTranslevel, dirFlags } from './owroute.ts';
import { OwRefusal, type OwRefusalData } from './owrefusal.ts';
import type { PathKind, PathShapes } from './owpaths.ts';

export const STAR_TILE = 0x5f;
// whether layer 1 tile t is a star (the game compares the tile's low byte, $04915E: a tile 15F is one too)
export const isStar = (t: number): boolean => (t & 0xff) === STAR_TILE;

// the path kinds and shapes (owpaths.ts) the ways off a star are told by; shapes null while they are learned
export interface StarPaths { kinds: readonly PathKind[]; shapes: PathShapes | null }

// The directions (DIR_NAMES order) a path leads off cell i in on map `l1`: the tile next to it is a level, stop or exit
// tile, or a path tile with a way Mario steps onto going that way (any path tile while the shapes are learned)
export function starDirs(l1: ArrayLike<number>, i: number, p: StarPaths): number[] {
  const out: number[] = [];
  for (let d = 0; d < 4; d++) {
    const n = neighbor(i, d);
    if (n < 0) continue;
    const t = l1[n], k = p.kinds[t];
    const leads = k === 'level' || k === 'stop' || k === 'exit'
      || (SHAPED_KINDS.includes(k) && (!p.shapes || tileWays(t, k, p.shapes).some((w) => w.dir === d)));
    if (leads) out.push(d);
  }
  return out;
}
const noTranslevel = (kept: number): OwRefusalData => ({ kind: 'starNoTranslevel', max: MAX_TRANSLEVEL, kept });

// The translevels after layer 1 cells `cells` were painted (before → after: their tiles as the stroke found and left
// them, `after` the whole map they are on, for the stars' ways) into the map before events (event -1) or as after event
// `event` (`without`: owevents.ts layer1Without). A star on a cell without a translevel takes a free one
// (takeStopTranslevel: its settings reset, its initial flags the ways its paths open there, starDirs), so does one on a
// cell sharing its translevel with a level tile elsewhere; a star on a cell that is a level tile at another progress is
// refused (the table holds one translevel per cell). A cell that was a star or stop tile and is none now (nor a level
// tile) frees its translevel – unless the cell is one at another progress (heldElsewhere) –, reset once no cell holds
// it (a star's name goes with it). Written into the ROM (call it inside the stroke's ROM edit); throws (nothing written)
// where a star can't have one. The translevels taken and freed.
export function paintStars(rom: Rom, cells: Iterable<number>, before: ArrayLike<number>, after: ArrayLike<number>, p: StarPaths,
  event = -1, without: ArrayLike<number> | null = null): { taken: number[]; freed: number[] } {
  const tls = readTranslevels(rom), st = stopTranslevels(rom, tls);
  const isLevel = (t: number) => p.kinds[t] === 'level', isStop = (t: number) => p.kinds[t] === 'stop' || isLevel(t);
  const stopHeld = heldElsewhere(rom, isStop, event, without), levelHeld = heldElsewhere(rom, isLevel, event, without);
  // (the translevels a level tile enters, at any progress)
  let levels: Set<number> | null = null;
  const aLevels = (tl: number) => (levels ??= new Set([...cellsBecoming(rom, isLevel)].map((k) => tls[k]))).has(tl);
  const need: number[] = [], free: number[] = [];
  for (const i of cells) {
    if (isStar(after[i])) {
      if (tls[i] && levelHeld(i)) throw new OwRefusal({ kind: 'starOnLevel', cell: i, tl: tls[i] });
      if (!tls[i] || aLevels(tls[i])) need.push(i);
    } else if (tls[i] && isStop(before[i]) && !isStop(after[i]) && !stopHeld(i)) free.push(i);
  }
  if (need.length > st.free.length) throw new OwRefusal(noTranslevel(st.kept));
  const freed = free.map((i) => { const tl = tls[i]; tls[i] = 0; return tl; });
  // (one just freed is not taken: not in st.free)
  const taken = need.map((i) => takeStopTranslevel(rom, tls, st, i, dirFlags(starDirs(after, i, p))));
  for (const tl of new Set(freed)) if (!tls.includes(tl)) resetTranslevel(rom, tl);
  if (taken.length || freed.length) writeTranslevels(rom, tls);
  return { taken, freed };
}

// star i of map `l1` (the map before events or as after an event) given a translevel of its own, as a star painted
// there gets one (paintStars): for a star on translevel 0 (a hack's, or one painted before #288). Throws where none is
// left. The translevel taken
export function giveStarTranslevel(rom: Rom, i: number, l1: ArrayLike<number>, p: StarPaths): number {
  return paintStars(rom, [i], l1, l1, p).taken[0];
}

// the stars (cells) at any event progress – on the map before events, turned into one by the reveal list or an
// event's layer 1 change – that hold no translevel: Mario walks off them in the ways translevel 0's flags open, shared
// with every tile without one, and the status bar shows translevel 0's blank name
export function starsWithoutTranslevel(rom: Rom): number[] {
  const tls = readTranslevels(rom);
  return [...cellsBecoming(rom, isStar)].filter((i) => !tls[i]).sort((a, b) => a - b);
}
