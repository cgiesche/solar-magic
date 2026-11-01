// Secondary entrances over the ROM and the open level as edited (the edit session's): the entrances into a
// level, a new one (placed like its level's main entrance, or at a spot of the open level), moved, removed,
// switched to an exit to the overworld and back, its teleport destination, where an exit of the open level leads.
// Every change of an entrance is one ROM edit.
// The entrances into the open level and the exit graph are kept current here: they are worked out again
// whenever the ROM or the open level's exits differ from when they were, so also after undo/redo.

import type { Rom } from './rom.ts';
import type { EditSession } from './editsession.ts';
import {
  type SecondaryEntrance, type SecondaryHeader, readSecondaryEntrance, writeSecondaryEntrance, decodeSecondaryEntrance, readSecondaryHeader,
  mainSpot, secondarySpot, setSecondarySpot, sameSpot, placeSecondary, entrancePos, nearestEntrance, copyCameraStart, copyEntranceOptions,
  newOverworldExit, hasRelativeCamera, levelMode, isSized, levelRows, setExitSecondary, SEC_ENT, midwaySpot, type Level,
} from './level.ts';
import { ExitGraph, entrancesInto, isOverworldExit } from './exitgraph.ts';
import { locationFor, tileText, type OwTile } from './owteleport.ts';
import { hex } from './names.ts';

const ENTRANCES = 0x200;
export const NO_FREE_ENTRANCE = 'No free secondary entrance left.';
const label = (idx: number, what: string) => `Secondary entrance ${hex(idx, 3)}${what}`;

// where an exit leads: a level's main entrance, a secondary entrance into a level (its first one, a chosen one or
// a new one), the overworld
export type ExitLeadsTo =
  | { kind: 'main'; level: number }
  | { kind: 'secondary'; level: number; entrance?: number | 'new' }
  | { kind: 'overworld' };

// entrance markers: main entrance, midway point, secondary entrances leading into this level
export interface Marker { kind: 'main' | 'midway' | 'sec'; index: number; x: number; y: number }

// A level's entrance markers at Mario's top-left pixel: its midway point, its main entrance and the secondary
// entrances `secs` into it (SecondaryEntrances.inLevel)
export function entranceMarkers(rom: Rom, lv: Pick<Level, 'secondary'>, secs: number[]): Marker[] {
  const s = lv.secondary;
  const vert = (s.verticalPositioning & 1) !== 0;
  const main = entrancePos(rom, mainSpot(s), vert);
  const mid = entrancePos(rom, midwaySpot(s), vert);
  const out: Marker[] = [{ kind: 'midway', index: 0, ...mid }, { kind: 'main', index: 0, ...main }];
  for (const i of secs) out.push({ kind: 'sec', index: i, ...entrancePos(rom, secondarySpot(readSecondaryEntrance(rom, i)), vert) });
  return out;
}

type Session = Pick<EditSession, 'rom' | 'level' | 'romEdit' | 'editLevel'>;

export class SecondaryEntrances {
  private readonly session: Session;
  private into: { key: string; list: number[] } | null = null;
  private exits: { key: string; graph: ExitGraph } | null = null;

  constructor(session: Session) {
    this.session = session;
  }

  private get rom(): Rom { return this.session.rom; }

  // all exits of the ROM, the open level's as edited
  graph(): ExitGraph {
    const lv = this.session.level;
    const key = `${this.rom.gen}/${lv.number}/${lv.exits.map((e) => `${e.screen},${e.dest},${+e.secondary},${e.flags}`).join(';')}`;
    if (this.exits?.key !== key) this.exits = { key, graph: new ExitGraph(this.rom, lv) };
    return this.exits.graph;
  }

  // the secondary entrances into the open level, of either bank (not blank ones, not its exits to the overworld)
  inOpenLevel(): number[] {
    const n = this.session.level.number, key = `${this.rom.gen}/${n}`;
    if (this.into?.key !== key) this.into = { key, list: entrancesInto(this.rom, n) };
    return this.into.list;
  }

  // a level's own: the entrances into it and its exits to the overworld
  ownedBy(level: number): number[] {
    const own = new Set(this.graph().entrancesOf(level));
    for (let i = 0; i < ENTRANCES; i++) if (isOverworldExit(this.rom, i) && readSecondaryEntrance(this.rom, i).destLevel === level) own.add(i);
    return [...own].sort((a, b) => a - b);
  }

  get(idx: number): SecondaryEntrance {
    return readSecondaryEntrance(this.rom, idx);
  }

  // the secondary entrances into a level (the open one: inOpenLevel)
  inLevel(level: number): number[] {
    return level === this.session.level.number ? this.inOpenLevel() : entrancesInto(this.rom, level);
  }

  // Mario's top-left pixel at an entrance into the open level
  place(idx: number): { x: number; y: number } {
    return entrancePos(this.rom, secondarySpot(this.get(idx)), this.vertical());
  }

  // the secondary header of a level, the open one as edited
  headerOf(level: number): SecondaryHeader {
    return level === this.session.level.number ? this.session.level.secondary : readSecondaryHeader(this.rom, level);
  }

  // whether an entrance into the level can start the camera relative to Mario (see hasRelativeCamera)
  relativeCamera(level: number): boolean {
    return hasRelativeCamera(this.rom, level === this.session.level.number ? this.session.level.header.mode : levelMode(this.rom, level));
  }

  // changes an entrance: "Secondary entrance XXX: what" (edits with the same key merge)
  edit(idx: number, what: string, f: (e: SecondaryEntrance) => void, key: string | null = null): void {
    this.write(idx, `: ${what}`, f, key && `sec-entrance-${key}:${idx}`);
  }

  // a new entrance into `level`, placed like its main entrance; null when none is free
  create(level: number): number | null {
    const idx = this.graph().freeEntrance();
    if (idx === null) return null;
    this.write(idx, ' created', (e) => { e.destLevel = level; this.likeMain(e); });
    return idx;
  }

  // a new entrance into the open level at the entrance setting nearest to Mario's top-left pixel (px, py)
  createAt(px: number, py: number): number | null {
    const idx = this.graph().freeEntrance();
    if (idx === null) return null;
    const p = this.nearest(px, py);
    this.write(idx, ' created', (e) => { e.destLevel = this.session.level.number; placeSecondary(e, p); });
    return idx;
  }

  // moves an entrance into the open level to the setting nearest to (px, py) (successive moves merge); false
  // when it is there already
  move(idx: number, px: number, py: number): boolean {
    const p = this.nearest(px, py);
    if (sameSpot(secondarySpot(this.get(idx)), p)) return false;
    this.write(idx, ' moved', (e) => placeSecondary(e, p), `sec-entrance:${idx}`);
    return true;
  }

  // clears an entrance (all bytes 0: free again)
  remove(idx: number): void {
    this.session.romEdit(label(idx, ' removed'), () => writeSecondaryEntrance(this.rom, idx, decodeSecondaryEntrance([0, 0, 0, 0, 0, 0])));
  }

  // Lunar Magic's "Exit to overworld": on, passing its level with the normal exit; off, into its level like the
  // main entrance
  setOverworld(idx: number, on: boolean): void {
    this.write(idx, on ? ': to the overworld' : ': into its level', (e) => {
      if (on) { e.overworld = newOverworldExit(); return; }
      e.overworld = null;
      this.likeMain(e);
    }, `sec-entrance-overworld:${idx}`);
  }

  // an exit to the overworld of `level` for an exit: one no exit uses, else a new one; null when none is free
  overworldExit(level: number): number | null {
    const g = this.graph();
    const used = g.unusedOverworldExit(level);
    if (used !== null) return used;
    const idx = g.freeEntrance();
    if (idx === null) return null;
    this.write(idx, ' to the overworld created', (e) => { e.destLevel = level; e.overworld = newOverworldExit(); });
    return idx;
  }

  // the open level's exit on `screen` leads to `to`: into a secondary entrance, the level's first one unless one
  // is chosen, else a new one placed like its main entrance; to the overworld through an exit to the overworld
  // of the open level no exit uses, else a new one (passing the level with the normal exit). Returns the entrance
  // it created (a ROM edit before the level edit), else null; throws when it needs one and none is free.
  leadExit(screen: number, to: ExitLeadsTo): number | null {
    if (!this.session.level.exits.some((e) => e.screen === screen)) throw new Error(`No exit on screen ${hex(screen, 2)}.`);
    const { dest, created } = this.destOf(to);
    this.session.editLevel((lv) => {
      const e = lv.exits.find((e) => e.screen === screen)!;
      setExitSecondary(e, to.kind !== 'main');
      e.dest = dest;
    }, false);
    return created;
  }

  // the exit's destination for `to`: a level, or the entrance (created ones told)
  private destOf(to: ExitLeadsTo): { dest: number; created: number | null } {
    if (to.kind === 'main') return { dest: to.level, created: null };
    const n = this.session.level.number;
    const found = to.kind === 'overworld' ? this.graph().unusedOverworldExit(n)
      : to.entrance === 'new' ? null : to.entrance ?? this.graph().entrancesOf(to.level)[0] ?? null;
    if (found !== null) return { dest: found, created: null };
    const created = to.kind === 'overworld' ? this.overworldExit(n) : this.create(to.level);
    if (created === null) throw new Error(NO_FREE_ENTRANCE);
    return { dest: created, created };
  }

  // an exit to the overworld teleports to `tile`: the location index leading there, or a new one (one ROM edit);
  // throws when all locations are in use
  teleport(idx: number, tile: OwTile): void {
    this.session.romEdit(label(idx, `: teleport to ${tileText(tile)}`), () => {
      const loc = locationFor(this.rom, tile);
      if (loc === null) throw new Error('All 256 locations of the overworld\'s star/pipe table are in use.');
      const e = this.get(idx);
      e.overworld = { ...e.overworld!, teleport: 1, location: loc };
      writeSecondaryEntrance(this.rom, idx, e);
    });
  }

  private write(idx: number, what: string, f: (e: SecondaryEntrance) => void, key: string | null = null): void {
    const e = this.get(idx);
    f(e);
    this.session.romEdit(label(idx, what), () => writeSecondaryEntrance(this.rom, idx, e), { key });
  }

  // its level's main entrance: position, action, camera start, options
  private likeMain(e: SecondaryEntrance): void {
    const s = this.headerOf(e.destLevel);
    setSecondarySpot(e, mainSpot(s));
    e.action = s.entranceAction;
    copyCameraStart(e, s);
    copyEntranceOptions(e, s);
  }

  private vertical(): boolean {
    return (this.session.level.secondary.verticalPositioning & 1) !== 0;
  }

  // in a level with a size at the tile there (the game's table positions don't reach its rows)
  private nearest(px: number, py: number) {
    const lv = this.session.level, s = lv.secondary;
    return nearestEntrance(this.rom, px, py, this.vertical(), lv.header.screens - 1, isSized(s) ? levelRows(s) : 0);
  }
}

// the bytes of all entrances (for a follow-up of ROM edits: the entrances changed)
export const entranceTables = (rom: Rom): string => SEC_ENT.map((t) => Array.from(rom.bytes(t, ENTRANCES)).join()).join('/');
