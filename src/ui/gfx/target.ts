// What the graphics workspace edits, described once (#240): the open level with its FG or BG Map16 tiles, or a submap
// of the overworld with the overworld's layer 1 tiles (drawn as on that submap). The tabs (palettes, Map16, graphics,
// animations) ask the descriptor what the target has and how its data is read and written, instead of branching on
// which target it is; only how it is drawn (the level's render or the submap's load) stays theirs.

import type { App } from '../app.ts';
import type { WsTarget } from '../gfxworkspace.ts';
import { h } from '../dom.ts';
import { hex } from '../../core/names.ts';
import { EXT_FIRST, EXT_TILES } from '../../core/map16ext.ts';
import { BG_EXT_FIRST, bgTileAddr, bgTileWords, setBgExtTileWords } from '../../core/bgmap16.ts';
import { fgTileAddr, setFgWords, map16Source } from '../../core/render.ts';
import { levelSlots, assignSlot, type GfxSlot } from '../../core/gfxslots.ts';
import { submapSlots, assignSubmapSlot, submapPaletteAddr, submapPalette, SUBMAP_LT3_DEST } from '../../core/submapgfx.ts';
import { submapGfxEntry } from '../../core/patches.ts';
import { MAP_NAMES, overworldReplacement, OW_L1_TILES, owTileAddr, owTileWords, setOwTileWords, owTileUses } from '../../core/overworld.ts';
import { namesOf, type NameKind } from '../../core/usernames.ts';
import { fgTileUsers, bgTileUsers, tileLinks, isTilesetTile, TILE_SOURCES } from '../../core/levelusage.ts';
import type { ExListRef } from '../../core/exanim.ts';
import { tileMatches, tileBehaviors } from '../tilesearch.ts';
import { blockFilesByTile } from '../blockdialog.ts';
import { usedInList } from '../usedin.ts';

// the Map16 tiles edited: the level's FG or BG tiles, or the overworld's layer 1 tiles
export type Map16Target = 'fg' | 'bg' | 'ow';

// a labelled range of tile numbers in the Map16 sheet's margin
export interface Band { from: number; to: number; color: string; label: string }

export interface GfxTarget {
  readonly id: Map16Target;
  // the workspace's target (the submap, the event progress its load is shown at)
  readonly at: WsTarget;

  // ---- whose graphics: the level's or the submap's
  readonly owner: string; // "level 105", "Yoshi's Island"
  readonly heading: string; // "Level 105", "Yoshi's Island"
  readonly short: string; // "level 105", "submap 1"
  readonly title: string; // "Level 105", "Submap 1: Yoshi's Island"
  readonly where: 'level' | 'submap';
  readonly fileName: string; // the start of an exported file's name
  readonly previewName: string; // what the workspace's preview shows
  // the preview shows the level: a click there picks its Map16 tiles, they are marked there
  readonly levelPreview: boolean;
  // the package that replaced its formats (ADR 0005: the overworld's), null: it is edited here
  locked(): string | null;
  // the graphics files' slots, putting a file into one (0xff: the default)
  slots(): GfxSlot[];
  assignSlot(name: string, file: number): void;
  // the default files: from the level header (tileset, sprite graphics), else the game's
  readonly headerDefaults: boolean;
  slotDefault(s: GfxSlot): string;
  // a slot's change offers to remap the Map16 tiles 200–FFF still drawing from the old place (Map16 tiles of levels)
  readonly slotRemap: boolean;
  // its entry in the layer 3 graphics settings, the LT3 file's destinations it takes
  readonly layer3: number;
  lt3Dest(dest: number): boolean;
  readonly lt3Title: string;
  // the animations shown on it: the game's own (app.animated) and the own ones linked (animsAt, colorAnimsAt)
  readonly anims: boolean;
  // its ExAnimation lists (own, global); the overworld's engine (its triggers 01–08 are events)
  animList(global: boolean): ExListRef;
  readonly owAnims: boolean;
  // the SNES address of its own 256 colors when it always has them (a submap's), null: the level's (traced,
  // shared or its own palette)
  ownColors(special: boolean): number | null;
  // the colors the game keeps rewriting (cgram: the submap's load as shown, null while it is emulated)
  animatedColors(cgram: Uint8Array | null, special: boolean): Set<number> | null;

  // ---- its Map16 tiles
  readonly map16: Map16Target; // the Map16 tiles it draws (for links: the level's FG tiles)
  readonly layer: string; // "FG", "BG", "OW"
  readonly tiles: number;
  readonly digits: number;
  // the tiles the remap's "uses" scope looks through (from here on), as said
  readonly usesFirst: number;
  readonly usesRange: string;
  readonly names: NameKind | null; // tile names
  readonly acts: boolean; // acts-like, blocks and behavior
  readonly move: boolean; // a tile move with every use
  readonly files: boolean; // .map16 import and export
  readonly palettes: boolean; // its colors open in the Palettes tab from the builder
  readonly searchHint: string;
  words(t: number): number[];
  setWords(t: number, ws: number[]): void;
  addr(t: number): number; // -1: an extended tile not created yet
  // the tiles it draws (the level's: those placed in it, else the standard pages)
  drawnTiles(): number[];
  // the 8x8 graphics its tiles are made of, by slot (the overworld's: VRAM after the submap's load)
  vram(): GfxSlot[];
  range(t: number): string;
  pageTitle(p: number): string;
  bands(): Band[];
  // the tiles matching a search (null: none typed), tiles whose behavior is still being determined
  match(query: string): { match: number[] | null; pending: number };
  // where a tile is used (link: a tile link; unused: the defined FG tiles 200–FFF used nowhere, null while not known)
  usedIn(t: number, link: (t: number) => HTMLElement, unused: Set<number> | null): HTMLElement[];
}

// "tileset 1", "tilesets 0, 7, C"
export const tilesetNames = (ts: number[]): string => `tileset${ts.length > 1 ? 's' : ''} ${ts.map((x) => hex(x, 1)).join(', ')}`;

// the overworld's 8x8 graphics as in VRAM after its load: four slots of 128 (no file behind them here)
const OW_SLOTS: GfxSlot[] = [0, 1, 2, 3].map((k) => ({ name: `VRAM ${k + 1}`, kind: 'gfx', k, file: -1, def: -1, custom: false, first: k * 0x80, sprite: false, map16: true }));

// the descriptor of the workspace's target `at`; for the level, `layer` chooses its FG or BG tiles
export function gfxTarget(app: App, at: WsTarget, layer: 'fg' | 'bg' = 'fg'): GfxTarget {
  return at.submap === null ? levelTarget(app, at, layer) : submapTarget(app, at, at.submap);
}

function levelTarget(app: App, at: WsTarget, layer: 'fg' | 'bg'): GfxTarget {
  const rom = app.rom, lv = app.level, n = lv.number, fg = layer === 'fg';
  const own = `level ${hex(n, 3)}`, Own = `Level ${hex(n, 3)}`;
  return {
    id: layer, at,
    owner: own, heading: Own, short: own, title: Own, where: 'level', fileName: `level${hex(n, 3)}`, previewName: 'level preview',
    levelPreview: true,
    locked: () => null,
    slots: () => levelSlots(rom, n, lv.header),
    assignSlot: (name, file) => assignSlot(rom, n, name, file),
    headerDefaults: true,
    slotDefault: (s) => (s.sprite ? 'from the sprite graphics in the header' : 'from the tileset in the header'),
    slotRemap: true,
    layer3: n,
    lt3Dest: () => true,
    lt3Title: 'Where the file goes: “Under the status bar” keeps the status bar\'s tilemap, the others overwrite (part of) it',
    anims: fg,
    animList: (global) => (global ? { kind: 'global' } : { kind: 'level', n }),
    owAnims: false,
    ownColors: () => null,
    animatedColors: () => app.animated()?.colors ?? null,

    map16: 'fg',
    layer: fg ? 'FG' : 'BG',
    tiles: EXT_TILES,
    digits: 3,
    usesFirst: EXT_FIRST,
    usesRange: '200–FFF',
    names: layer,
    acts: fg,
    move: true,
    files: true,
    palettes: true,
    searchHint: fg ? 'Tile no. (hex), name, behavior or block file …' : 'Tile no. (hex) or name …',
    words: (t) => (fg ? map16Source(rom, app.render).fg(t) : bgTileWords(rom, t)),
    setWords: (t, ws) => {
      if (fg) setFgWords(rom, app.render, t, ws);
      else if (t >= BG_EXT_FIRST) setBgExtTileWords(rom, t, ws);
      else { const a = bgTileAddr(rom, t)!; ws.forEach((v, q) => rom.w16(a + q * 2, v)); }
    },
    addr: (t) => (fg ? fgTileAddr(rom, app.render, t) : bgTileAddr(rom, t) ?? -1),
    vram: () => levelSlots(rom, n, lv.header),
    drawnTiles: () => {
      const inLevel = new Set(app.images?.tiles1 ?? []);
      return inLevel.size > 1 ? [...inLevel] : Array.from({ length: EXT_FIRST }, (_, i) => i);
    },
    range: (t) => {
      if (!fg) return t >= BG_EXT_FIRST ? 'extended background tile' : 'background tile';
      if (t >= EXT_FIRST) return 'extended tile (in the level via Direct Map16 object)';
      if (isTilesetTile(t)) { const ts = app.tilesetsOf(t); return `tileset tile (applies to ${tilesetNames(ts)}${ts.length > 1 ? '' : ' only'})`; }
      return 'standard tile (all tilesets)';
    },
    pageTitle: (p) => (p < 2 ? `Page ${p}: ${!fg ? 'BG tiles of the original backgrounds' : p ? 'standard tiles' : 'standard and tileset tiles'}`
      : `Page ${hex(p, 1)}: extended ${!fg ? 'BG ' : ''}tiles${!fg ? '' : ' (in the level via Direct Map16 object)'}`),
    bands: () => {
      if (!fg) return [{ from: 0, to: 0x1ff, color: '#7d8bff', label: 'Background tiles' }, { from: BG_EXT_FIRST, to: EXT_TILES - 1, color: '#4cc2ff', label: 'Extended' }];
      // (the tilesets sharing all of them)
      let ts = app.tilesetsOf(0x073);
      for (let t = 0x074; t <= 0x0ff; t++) { const of = app.tilesetsOf(t); ts = ts.filter((x) => of.includes(x)); }
      return [
        { from: 0x000, to: 0x072, color: '#8b93a3', label: 'Standard' },
        { from: 0x073, to: 0x0ff, color: '#ffb000', label: `Tileset${ts.length > 1 ? 's' : ''} ${ts.map((x) => hex(x, 1)).join('/')}` },
        { from: 0x100, to: 0x1ff, color: '#8b93a3', label: 'Standard' },
        { from: 0x200, to: EXT_TILES - 1, color: '#4cc2ff', label: 'Extended' },
      ];
    },
    // custom blocks and behavior are FG tiles' only
    match: (q) => {
      if (!fg) return { match: tileMatches(q, EXT_TILES, [namesOf(rom, 'bg')]), pending: 0 };
      const behaviors = tileBehaviors(app, q, EXT_TILES);
      return { match: tileMatches(q, EXT_TILES, [blockFilesByTile(rom), namesOf(rom, 'fg'), behaviors.texts]), pending: behaviors.pending };
    },
    usedIn: (t, link, unused) => {
      const { levels, pending, open } = app.levelTiles();
      const unknown = open === 'failed' ? `The tiles this level places as edited could not be learned${levels.some((l) => l.level === n) ? ' (listed as last known)' : ''}.` : undefined;
      if (!fg) {
        const users = bgTileUsers(levels, t);
        return [usedInList(app, 'Used in levels', users.map((u) => ({ level: u.level, text: `${u.count}× in the BG` })), pending, 'In no level\'s background.', unknown)];
      }
      const tilesets = app.tilesetsOf(t), tilesetTile = isTilesetTile(t);
      const items = fgTileUsers(levels, t, tilesets).map((u) => ({
        level: u.level, at: { x: u.uses[0].x, y: u.uses[0].y },
        text: u.uses.map((q) => `${q.count}× ${TILE_SOURCES[q.source]}${q.layer === 2 ? ' (layer 2)' : ''}`).join(', '),
      }));
      const l = tileLinks(rom, t);
      return [
        usedInList(app, tilesetTile ? `Used in levels of ${tilesetNames(tilesets)}` : 'Used in levels', items, pending, unused?.has(t) ? 'Defined, but placed in no level and no prefab: unused.' : 'Placed in no level.', unknown),
        ...(l.actsLike.length ? [h('div', { class: 'hint' }, 'Acting like it: ', ...l.actsLike.slice(0, 24).flatMap((x, i) => [i ? ' ' : '', link(x)]), l.actsLike.length > 24 ? ` … (${l.actsLike.length})` : '')] : []),
        ...(l.prefabs.length ? [h('div', { class: 'hint' }, `In prefab${l.prefabs.length > 1 ? 's' : ''} ${l.prefabs.map((x) => hex(x, 2)).join(', ')}`)] : []),
        ...(l.blocks.length ? [h('div', { class: 'hint' }, `Custom block on it: ${l.blocks.join(', ')}`)] : []),
      ];
    },
  };
}

function submapTarget(app: App, at: WsTarget, m: number): GfxTarget {
  const rom = app.rom, name = MAP_NAMES[m];
  return {
    id: 'ow', at,
    owner: name, heading: name, short: `submap ${m}`, title: `Submap ${m}: ${name}`, where: 'submap', fileName: `submap${m}`, previewName: 'map',
    levelPreview: false,
    locked: () => overworldReplacement(rom),
    slots: () => submapSlots(rom, m),
    assignSlot: (slot, file) => assignSubmapSlot(rom, m, slot, file),
    headerDefaults: false,
    slotDefault: () => 'the overworld\'s graphics in the game',
    slotRemap: false,
    layer3: submapGfxEntry(m),
    lt3Dest: (d) => d === SUBMAP_LT3_DEST,
    lt3Title: 'On the overworld the file replaces the border from the start of layer 3',
    anims: false,
    animList: (global) => (global ? { kind: 'owGlobal' } : { kind: 'submap', n: m }),
    owAnims: true,
    ownColors: (special) => submapPaletteAddr(rom, m, special),
    // (the colors its load's CGRAM has other than its palette; with the special world's colors none: the preview
    // shows the submap before it)
    animatedColors: (c, special) => {
      if (special || !c) return null;
      const pal = submapPalette(rom, m);
      return new Set(Array.from({ length: 256 }, (_, i) => i).filter((i) => c[i * 2] !== pal[i * 2] || c[i * 2 + 1] !== pal[i * 2 + 1]));
    },

    map16: 'ow',
    layer: 'OW',
    tiles: OW_L1_TILES,
    digits: 2,
    usesFirst: 0,
    usesRange: '00–C0',
    names: null,
    acts: false,
    move: false,
    files: false,
    palettes: false,
    searchHint: 'Tile no. (hex) …',
    words: (t) => (t < OW_L1_TILES ? owTileWords(rom, t) : [0, 0, 0, 0]),
    setWords: (t, ws) => setOwTileWords(rom, t, ws),
    addr: (t) => owTileAddr(t),
    vram: () => OW_SLOTS,
    drawnTiles: () => Array.from({ length: OW_L1_TILES }, (_, i) => i),
    range: () => `overworld layer 1 tile (all maps; drawn as on ${name})`,
    pageTitle: () => '',
    bands: () => [{ from: 0, to: OW_L1_TILES - 1, color: '#7dd87d', label: 'Overworld' }],
    match: (q) => ({ match: tileMatches(q, OW_L1_TILES), pending: 0 }),
    // on the maps as in the ROM (before events)
    usedIn: (t) => {
      const u = owTileUses(rom, t);
      return [h('div', { class: 'hint' }, u.main || u.submaps ? `On layer 1: ${u.main}× on the main map, ${u.submaps}× on the submaps (before events)` : 'On no overworld map (before events).')];
    },
  };
}
