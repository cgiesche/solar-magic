// Overworld link ends in an overlap of submaps' views (CONTEXT.md "Submap", "Overworld link", #404). The submaps share
// one layer 1 region and their views overlap: Vanilla Dome 05,14 (its entrance) shows in Forest of Illusion's view
// too. A link end stores its submap; where the user drops one on a tile several views show, the editor asks which
// (endChoice: the submap whose paths the tile is on first – pathSubmap –, then the shown one, then the nearest view's);
// a click there finds the links ending there on any of those submaps (linksEndingAt); and the World check warns of an
// end stored on a submap whose paths the tile is not on but another's is (misplacedEnds), its fix moving the end there
// (moveEnd, one ROM edit).

import type { Rom } from './rom.ts';
import { l1Index, l1XY, MAP_NAMES } from './overworld.ts';
import { inView, submapOf, submapShown, type Rect } from './owevents.ts';
import { neighbor } from './owreach.ts';
import { readLinks, removeLink, makeLink, type OwLink, type LinkEnd } from './owlinks.ts';
import { tileText, type OwTile } from './owteleport.ts';
import type { PathKind } from './owpaths.ts';

const SUBMAPS = MAP_NAMES.length;
// the layer 1 tile (l1Index) of a link end
export const endTile = (t: OwTile): number => l1Index(t.submap ? 1 : 0, t.x, t.y);

// the submaps whose views show layer 1 tile i (owevents.ts inView), in number order; a tile of the main map: [0]
export function submapsShowing(views: readonly Rect[], i: number): number[] {
  if (i < 0x400) return [0];
  const out: number[] = [];
  for (let k = 1; k < SUBMAPS && k < views.length; k++) if (inView(views[k], i)) out.push(k);
  return out;
}

// The submap of `among` (by default the submaps whose views show it) whose paths layer 1 tile i is on: the stop and
// level tiles connected to it along walkable tiles (path kinds: not "none"; an exit path tile other than i is passed
// onto, not over – it leads elsewhere) counted per submap whose view of `among` alone shows them; the one with the
// most. null: not decided – fewer than two submaps to choose from, none connected or a tie. `l1`: layer 1 as the
// paths are with every event passed (gameL1).
export function pathSubmap(l1: ArrayLike<number>, kinds: readonly PathKind[], views: readonly Rect[], i: number, among = submapsShowing(views, i)): number | null {
  if (among.length < 2) return null;
  const seen = new Set([i]), queue = [i], score = new Map<number, number>();
  while (queue.length) {
    const t = queue.pop()!, k = kinds[l1[t]];
    if (k === 'stop' || k === 'level') {
      const own = among.filter((s) => inView(views[s], t));
      if (own.length === 1) score.set(own[0], (score.get(own[0]) ?? 0) + 1);
    }
    if (t !== i && k === 'exit') continue;
    for (let d = 0; d < 4; d++) {
      const n = neighbor(t, d);
      if (n < 0 || seen.has(n) || kinds[l1[n]] === 'none') continue;
      seen.add(n);
      queue.push(n);
    }
  }
  const best = [...score].sort((a, b) => b[1] - a[1]);
  return best.length && (best.length < 2 || best[0][1] > best[1][1]) ? best[0][0] : null;
}

// The submaps a link end dropped on layer 1 tile i can be on, where the user acts on submap `shown`: every submap whose
// view shows it, the one preselected first – the submap whose paths it is on (pathSubmap), else `shown` when among
// them, else the nearest view's (submapOf). One submap (a tile in one view only, or the main map): taken without asking
// (submapShown); none of them (a tile no view shows): submapOf's.
export function endChoice(l1: ArrayLike<number>, kinds: readonly PathKind[], views: readonly Rect[], i: number, shown: number): number[] {
  const among = submapsShowing(views, i);
  if (among.length < 2) return [submapShown(views, i, shown)];
  const near = submapOf(views, i), first = pathSubmap(l1, kinds, views, i, among) ?? (among.includes(shown) ? shown : among.includes(near) ? near : among[0]);
  return [first, ...among.filter((s) => s !== first)];
}

// endChoice in the status bar while a link end is dragged: "→ Vanilla Dome 05,14", "· in an overlap, you'll be asked"
// where the menu will come
export function endChoiceText(choice: readonly number[], i: number): string {
  const t = { submap: choice[0], ...l1XY(i) };
  return `→ ${tileText(t)}${choice.length > 1 ? ' · in an overlap, you\'ll be asked' : ''}`;
}

// The links with an end at layer 1 tile i on one of `submaps` (by default the submaps whose views show it), in the order
// of `submaps` – the shown one first, say –, a link's source before its target; a link once (its first end found)
export function linksEndingAt(links: readonly OwLink[], i: number, submaps: readonly number[]): { link: OwLink; end: 'a' | 'b' }[] {
  const { x, y } = l1XY(i), region = i >> 10, out: { link: OwLink; end: 'a' | 'b' }[] = [];
  const at = (t: LinkEnd, s: number) => t.submap === s && (t.submap ? 1 : 0) === region && t.x === x && t.y === y;
  for (const s of submaps) {
    for (const end of ['a', 'b'] as const) {
      for (const link of links) if (at(link[end], s) && !out.some((o) => o.link === link)) out.push({ link, end });
    }
  }
  return out;
}

// a link end stored on a submap whose paths its tile is not on, another's whose view shows it is: the link, the end
// (a: its source, b: its target) and the submap the paths are of
export interface MisplacedEnd { link: OwLink; end: 'a' | 'b'; to: number }
// The link ends on a submap where the tile isn't on its paths but on those of another submap whose view shows it
// (pathSubmap decides it: none where it doesn't) – likely meant for that one: written with the nearest view's submap
// in an overlap. None in the clean game. `l1`: layer 1 with every event passed.
export function misplacedEnds(links: readonly OwLink[], l1: ArrayLike<number>, kinds: readonly PathKind[], views: readonly Rect[]): MisplacedEnd[] {
  const out: MisplacedEnd[] = [];
  for (const link of links) {
    for (const end of ['a', 'b'] as const) {
      const t = link[end];
      if (!t.submap) continue;
      const i = endTile(t), among = submapsShowing(views, i);
      if (!among.includes(t.submap)) continue; // (outside its view: the links panel warns of it)
      const to = pathSubmap(l1, kinds, views, i, among);
      if (to !== null && to !== t.submap) out.push({ link, end, to });
    }
  }
  return out;
}
// The links a click at layer 1 tile i selects among (`order`: the submaps whose views show it, the one the user acts on
// first): of those ending there (linksEndingAt) the first when they are all on one submap or one is on order[0], else
// all of them – to choose from (none: no link there)
export function clickedLinks(links: readonly OwLink[], i: number, order: readonly number[]): OwLink[] {
  const found = linksEndingAt(links, i, order), on = new Set(found.map((f) => f.link[f.end].submap));
  return on.size < 2 || on.has(order[0]) ? found.slice(0, 1).map((f) => f.link) : found.map((f) => f.link);
}

// a misplaced end in words: "The link from Yoshi's Island 0C,08 leads to Forest of Illusion 05,14 – that cell's paths
// are Vanilla Dome's"
export function misplacedText(m: MisplacedEnd): string {
  const { a, b } = m.link, why = ` – that cell's paths are ${MAP_NAMES[m.to]}'s`;
  return m.end === 'b' ? `The link from ${tileText(a)} leads to ${tileText(b)}${why}` : `The link to ${tileText(b)} starts at ${tileText(a)}${why}`;
}

// The misplaced end moved to the submap its paths are of (call it inside one ROM edit): the link removed and made again
// (owlinks.ts: an exit path's target side derived from its source's), the link as found in the ROM then (`link`: as
// read with readLinks' isExit, the entries the ROM has)
export function moveEnd(rom: Rom, m: MisplacedEnd): OwLink {
  const l = m.link, moved = { ...l[m.end], submap: m.to };
  removeLink(rom, l);
  return makeLink(rom, l.kind, m.end === 'a' ? moved : l.a, m.end === 'b' ? moved : l.b, l.both);
}

// the ROM's links (readLinks, the exit path tiles by `kinds` on `l1`) with ends misplaced
export function misplacedInRom(rom: Rom, l1: ArrayLike<number>, kinds: readonly PathKind[], views: readonly Rect[]): MisplacedEnd[] {
  return misplacedEnds(readLinks(rom, (t) => kinds[l1[endTile(t)]] === 'exit'), l1, kinds, views);
}
