// Blocks view of the Packages workspace (GPS format), a configuration view: assigns the blocks packages brought
// to Map16 tiles (with optional acts like); the project's files with their settings, export as a GPS
// folder (.zip).

import type { App } from './app.ts';
import { h, hexInput, select, type Child } from './dom.ts';
import { loadBlockProject, saveBlockProject, projectToZip, blockFiles, blocksEntry, assignBlock, type BlockProject } from '../core/blocks.ts';
import { EXT_FIRST, EXT_TILES } from '../core/map16ext.ts';
import { hex } from '../core/names.ts';
import { projectPane, type Pane, type PartRow } from './projectpane.ts';
import type { PartContext } from './pkginspect.ts';
import type { Rom } from '../core/rom.ts';
import { icon } from './icons.ts';

// block file per tile of the ROM's block project (cached per registry entry)
let cache: { id: string; tiles: Map<number, string> } | null = null;
export function blockFilesByTile(rom: Rom): Map<number, string> {
  const e = blocksEntry(rom);
  if (!e) return new Map();
  if (cache?.id !== e.id) {
    let p = null;
    try { p = loadBlockProject(rom); } catch { /* sources missing: no file names */ }
    cache = { id: e.id, tiles: new Map((p?.list ?? []).map((b) => [b.tile, b.file.replace(/^blocks\//, '')])) };
  }
  return cache.tiles;
}
export function blockFileOf(rom: Rom, tile: number): string | null {
  return blockFilesByTile(rom).get(tile) ?? null;
}

export type BlockPane = Pane & { tile(): number; setTile(t: number): void };

export function blockPane(app: App, changed: () => void, part?: PartContext, openTile?: (tile: number) => void): BlockPane {
  let tile = EXT_FIRST;
  let ownActs = false;
  let acts = 0x130;
  let pane: Pane;

  function content(proj: BlockProject, change: () => void, origin: (file: string) => HTMLElement, row: PartRow): Child[] {
    const files = blockFiles(proj.files);
    let file = files[0] ?? '';
    const actsIn = hexInput(acts, 3, (v) => (acts = v), 0x1ff);
    actsIn.disabled = !ownActs;
    const actsBox = h('input', { type: 'checkbox', checked: ownActs, onchange: () => { ownActs = actsBox.checked; actsIn.disabled = !ownActs; } });
    const add = () => {
      assignBlock(proj, { tile, file, acts: ownActs ? acts : undefined });
      change();
    };
    const rows = [...proj.list].sort((a, b) => a.tile - b.tile).map((b) => h('tr', row(String(b.tile), () => ({
      kind: 'Block', title: [h('span', { class: 'mono' }, hex(b.tile, 3)), ' ', b.file.replace(/^blocks\//, '')], file: b.file,
      facts: [['Tile', hex(b.tile, 3)], ['Acts like', b.acts !== undefined ? hex(b.acts, 3) : 'the tile’s own']],
      links: openTile ? [{ label: 'Open in the Map16 editor', run: () => openTile(b.tile) }] : [],
      hint: 'To place: Picker → Map16, or a Direct Map16 object with the tile.',
    }), b.tile === tile ? 'selected' : ''),
      h('td', { class: 'mono' }, hex(b.tile, 3)),
      h('td', { class: proj.files.has(b.file) ? '' : 'err', title: proj.files.has(b.file) ? b.file : `${b.file} is missing from the project` }, b.file.replace(/^blocks\//, '')),
      h('td', { class: 'mono' }, b.acts !== undefined ? hex(b.acts, 3) : '–'),
      h('td', null, origin(b.file)),
      h('td', { class: 'actions' }, h('button', { class: 'icon-btn', title: 'Remove assignment (the block stays)', onclick: () => { proj.list = proj.list.filter((x) => x !== b); change(); } }, icon('close')))));
    return [
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Tile'), h('th', null, 'Block'), h('th', null, 'acts like'), h('th', null, 'Package'), h('th')), rows)
        : h('p', { class: 'hint' }, 'No blocks yet – “Upload package …” above installs a block package; its blocks go on free Map16 tiles.'),
      files.length ? h('div', { class: 'row uber-add' },
        h('label', null, 'Tile'), hexInput(tile, 3, (v) => (tile = v), EXT_TILES - 1),
        select(files.map((f, i) => [i, f.slice(7)] as [number, string]), 0, (i) => (file = files[i])),
        h('label', { class: 'row small', title: 'Behavior without custom code; unchecked keeps the tile\'s own' }, actsBox, 'acts like'), actsIn,
        h('button', { onclick: add }, 'Assign')) : '',
    ];
  }

  pane = projectPane<BlockProject>(app, {
    title: 'Blocks',
    tool: 'block',
    intro: 'Blocks with custom behavior, each assigned to a Map16 tile.',
    format: 'GPS format: “db $42”/“db $37” and a JMP table with MarioBelow, MarioAbove, MarioSide, SpriteV, SpriteH, MarioCape, MarioFireball, TopCorner, BodyInside, HeadInside [, WallFeet, WallBody]. Shared routines from routines/ are called as %name(); those of GPS are built in. “acts like” sets the behavior without custom code.',
    load: () => loadBlockProject(app.rom),
    empty: () => ({ files: new Map(), list: [] }),
    save: (p) => { const r = saveBlockProject(app.rom, p); cache = null; return r; },
    toZip: projectToZip,
    zipName: 'blocks.zip',
    content,
    applied: (p) => `Custom blocks applied (${p.list.length} tile(s))`,
  }, changed, part);
  return { ...pane, tile: () => tile, setTile: (t) => { tile = t; pane.render(); } };
}
