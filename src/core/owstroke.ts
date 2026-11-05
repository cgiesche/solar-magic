// A paint stroke on the overworld (ADR 0005): begun on the maps the view keeps (as in the ROM, or as after an event
// being painted), cells painted into them, ended into one ROM edit. It hides the choice between the map before events
// (layer 1 where it changed, layer 2 in place when it fits) and the event's steps (layer 2: paintEvent; layer 1:
// paintEventL1 against the map after it without its layer 1 changes). Layer 1 strokes leave level tiles alone: they
// neither paint over one nor paint one (level tiles are placed, moved and removed in the Levels mode, ADR 0012). A
// star painted takes a translevel of its own, a star or stop painted over with a path frees its (owstars.ts paintStars).

import type { Rom } from './rom.ts';
import {
  type OwRender, readL2, writeL1, writeL2, l1Index, l2Index, gameL1, gameL2,
} from './overworld.ts';
import { readEvents, writeEvents, paintEvent, paintEventL1, eventRunners, eventTitle, type EventPlace } from './owevents.ts';
import type { LevelTileTest } from './owpaths.ts';
import { paintStars, type StarPaths } from './owstars.ts';
import { OwRefusal } from './owrefusal.ts';

export type StrokeLayer = 'l1' | 'l2';

// the maps a stroke paints, as the view keeps them: the maps as in the ROM with the stroke being painted
export interface OwMaps { l1: Uint16Array; l2: Uint16Array }

// the event being painted: layer 2 as after it (`after`), layer 1 as after it (`l1`, the game's at the event progress
// just after it with the strokes painted; `game` as the game showed it), layer 1 as after it without its layer 1
// changes (`without`, layer1Without; undefined while it is emulated, null when it could not be); where its steps are
// shown (`place`, asked when the stroke ends: null while the submaps' views are learned)
export interface OwEventMaps {
  event: number;
  after: Uint16Array;
  l1: Uint16Array | null;
  game: Uint16Array | null;
  without: Uint16Array | null | undefined;
  place: () => EventPlace | null;
}

// the end of a stroke: the ROM edit (`label`, `write`; null when nothing is written)
export interface StrokeEnd {
  label: string;
  write: (() => void) | null;
}

export class OverworldStroke {
  private readonly rom: Rom;
  readonly layer: StrokeLayer;
  private readonly maps: OwMaps;
  private readonly isLevelTile: LevelTileTest;
  private readonly ev: OwEventMaps | null;
  private readonly began: Uint16Array[]; // what it paints in place, as when it began (cancel)
  private readonly paths: StarPaths | null;
  // `maps` (and an event's `ev.after`/`ev.l1`) are painted in place: the view shows them while the stroke goes on;
  // paths: the path kinds and shapes the stars' translevels follow (null: layer 2, or the translevels left alone)
  constructor(rom: Rom, layer: StrokeLayer, maps: OwMaps, isLevelTile: LevelTileTest, ev: OwEventMaps | null = null, paths: StarPaths | null = null) {
    this.rom = rom; this.layer = layer; this.maps = maps; this.isLevelTile = isLevelTile; this.ev = ev; this.paths = paths;
    this.began = this.painted().map((a) => a.slice());
  }
  // the arrays the stroke paints in place
  private painted(): Uint16Array[] {
    const { maps, ev } = this;
    return [maps.l1, maps.l2, ...(ev ? [ev.after, ...(ev.l1 ? [ev.l1] : [])] : [])];
  }
  // the stroke dropped (Esc): what it painted put back as when it began; nothing is written
  cancel(): void {
    this.painted().forEach((a, k) => a.set(this.began[k]));
  }

  // the event the stroke paints as after (-1: the map before events)
  get event(): number { return this.ev?.event ?? -1; }

  // tile or tilemap entry v painted at cell (x, y) of a region (0 the main map, 1 the submaps; layer 1's 32x32 cells,
  // layer 2's 64x64). On layer 1 a level tile is neither painted nor painted over, NO_TILE (owl1sheet.ts) paints nothing. Whether the
  // cell changed
  paint(region: number, x: number, y: number, v: number): boolean {
    const { maps, ev } = this;
    if (this.layer === 'l2') {
      const i = l2Index(region, x, y), into = ev ? ev.after : maps.l2;
      if (into[i] === v) return false;
      into[i] = v;
      return true;
    }
    const i = l1Index(region, x, y), into = ev ? ev.l1 : maps.l1;
    if (!into || v < 0 || into[i] === v || this.isLevelTile(v) || this.isLevelTile(into[i])) return false;
    into[i] = v;
    return true;
  }

  // the ROM edit of the stroke; `write` throws when it can't be written (the submaps' views not known)
  end(): StrokeEnd {
    const { rom, maps, ev } = this;
    if (ev) {
      const title = eventTitle(eventRunners(rom), ev.event), e = ev.event;
      if (this.layer === 'l2') {
        const after = ev.after, place = ev.place();
        return {
          label: `${title}: paint`,
          write: () => {
            if (!place) throw new OwRefusal({ kind: 'submapsLoading' });
            writeEvents(rom, paintEvent(readEvents(rom), readL2(rom), e, after, place));
          },
        };
      }
      const after = ev.l1, game = ev.game, without = ev.without;
      const write = after && game && without ? () => {
        const painted = new Set([...after.keys()].filter((i) => after[i] !== game[i])), p = this.paths;
        if (p) paintStars(rom, painted, game, after, p, e, without);
        writeEvents(rom, paintEventL1(readEvents(rom), e, after, without, painted));
      } : null;
      return { label: `${title}: paint layer 1`, write };
    }
    if (this.layer === 'l2') return { label: 'Paint layer 2', write: () => writeL2(rom, maps.l2) };
    const before = this.began[0], l1 = maps.l1;
    return {
      label: 'Paint layer 1',
      write: () => {
        const p = this.paths;
        if (p) paintStars(rom, [...l1.keys()].filter((i) => l1[i] !== before[i]), before, l1, p);
        writeL1(rom, l1);
      },
    };
  }
}

// the maps of a region as the game shows them at an event progress (`r`, the game's load), with the tiles painted since
// the maps were as in `from` (the maps as in the ROM the load was made of): a painted tile shown as painted, the
// others as the game shows them. While an event is painted (`ev`), both layers as after it
export function shownMaps(
  r: OwRender, region: number, maps: OwMaps, from: { l1: Uint16Array; l2: Uint16Array }, ev?: { after: Uint16Array; l1: Uint16Array | null } | null,
): { l1: Uint16Array; l2: Uint16Array } {
  const base = region * 0x1000, game1 = gameL1(r), game2 = gameL2(r);
  return {
    l1: ev?.l1 ?? maps.l1.map((t, i) => (t !== from.l1[i] ? t : game1[i])),
    l2: ev ? ev.after : maps.l2.map((t, i) => (t !== from.l2[i] || i < base || i >= base + 0x1000 ? t : game2[i - base])),
  };
}
