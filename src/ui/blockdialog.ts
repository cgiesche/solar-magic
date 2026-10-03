// Custom blocks tab of the patches dialog (GPS format): assign block .asm files to Map16 tiles (with
// optional acts like), manage blocks/ and routines/, import/export a GPS folder (.zip).

import type { App } from './app.ts';
import { h, hexInput, select, type Child } from './dom.ts';
import { loadBlockProject, saveBlockProject, projectFromZip, projectToZip, blockFiles, blocksEntry, removeBlocks, type BlockProject } from '../core/blocks.ts';
import { EXT_FIRST, EXT_TILES } from '../core/map16ext.ts';
import { map16Source } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { definesButton } from './defineedit.ts';
import { projectPane, type Pane } from './projectpane.ts';
import type { Rom } from '../core/rom.ts';

// block file per tile of the ROM's block project (cached per registry entry)
let cache: { id: string; tiles: Map<number, string> } | null = null;
export function blockFileOf(rom: Rom, tile: number): string | null {
  const e = blocksEntry(rom);
  if (!e) return null;
  if (cache?.id !== e.id) {
    const p = loadBlockProject(rom);
    cache = { id: e.id, tiles: new Map((p?.list ?? []).map((b) => [b.tile, b.file.replace(/^blocks\//, '')])) };
  }
  return cache.tiles.get(tile) ?? null;
}

// the first tile from `from` on without a block
export function freeBlockTile(p: BlockProject | null, from = EXT_FIRST): number {
  const used = new Set((p?.list ?? []).map((b) => b.tile));
  let t = from;
  while (used.has(t) && t < EXT_TILES - 1) t++;
  return t;
}

export type BlockPane = Pane & { tile(): number; setTile(t: number): void };

export function blockPane(app: App, onDirty: () => void, changed: () => void): BlockPane {
  let tile = EXT_FIRST;
  let ownActs = false;
  let acts = 0x130;
  let pane: Pane;

  function content(proj: BlockProject, change: () => void): Child[] {
    const files = blockFiles(proj.files);
    let file = files[0] ?? '';
    const actsIn = hexInput(acts, 3, (v) => (acts = v), 0x1ff);
    actsIn.disabled = !ownActs;
    const actsBox = h('input', { type: 'checkbox', checked: ownActs, onchange: () => { ownActs = actsBox.checked; actsIn.disabled = !ownActs; } });
    const add = () => {
      proj.list = proj.list.filter((b) => b.tile !== tile);
      proj.list.push({ tile, file, acts: ownActs ? acts : undefined });
      change();
    };
    const rows = [...proj.list].sort((a, b) => a.tile - b.tile).map((b) => h('tr', { class: b.tile === tile ? 'selected' : '' },
      h('td', { class: 'mono' }, hex(b.tile, 3)),
      h('td', { class: proj.files.has(b.file) ? '' : 'err', title: proj.files.has(b.file) ? b.file : `${b.file} fehlt im Projekt` }, b.file.replace(/^blocks\//, '')),
      h('td', { class: 'mono' }, b.acts !== undefined ? hex(b.acts, 3) : '–'),
      h('td', { class: 'actions' }, definesButton(proj.files, b.file, change), h('button', { class: 'icon-btn', title: 'Zuordnung entfernen', onclick: () => { proj.list = proj.list.filter((x) => x !== b); change(); } }, '✕'))));
    return [
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Tile'), h('th', null, 'Block'), h('th', null, 'acts like'), h('th')), rows)
        : h('p', { class: 'hint' }, 'Noch keine Blöcke – „Hinzufügen …“ oben nimmt einen GPS-Block oder ein Block-Paket (.asm/.zip) und legt ihn auf ein Map16-Tile.'),
      files.length ? h('div', { class: 'row uber-add' },
        h('label', null, 'Tile'), hexInput(tile, 3, (v) => (tile = v), EXT_TILES - 1),
        select(files.map((f, i) => [i, f.slice(7)] as [number, string]), 0, (i) => (file = files[i])),
        h('label', { class: 'row small', title: 'Verhalten ohne eigenen Code; ohne Haken bleibt das des Tiles' }, actsBox, 'acts like'), actsIn,
        h('button', { onclick: add }, 'Zuordnen')) : '',
      h('p', { class: 'hint' }, 'Platzieren: Palette → Map16 bzw. Direct-Map16-Objekt mit dem jeweiligen Tile.'),
    ];
  }

  pane = projectPane<BlockProject>(app, {
    title: 'Custom Blocks',
    intro: 'Blöcke mit eigenem Verhalten, je einem Map16-Tile zugeordnet.',
    format: 'GPS-Format: „db $42“/„db $37“ und eine JMP-Tabelle mit MarioBelow, MarioAbove, MarioSide, SpriteV, SpriteH, MarioCape, MarioFireball, TopCorner, BodyInside, HeadInside [, WallFeet, WallBody]. Shared Routines aus routines/ werden als %name() aufgerufen, die von GPS sind eingebaut. Das Verhalten ohne eigenen Code bestimmt „acts like“.',
    load: () => loadBlockProject(app.rom),
    empty: () => ({ files: new Map(), list: [] }),
    save: (p) => { const r = saveBlockProject(app.rom, p, map16Source(app.rom, app.render).fg(0x025)); cache = null; return r; },
    remove: () => { cache = null; return removeBlocks(app.rom); },
    folders: ['blocks/', 'routines/'],
    accept: '.asm',
    addFile: (p, folder, path, data) => { if (/\.asm$/i.test(path)) p.files.set(folder + path, data); },
    fromZip: projectFromZip,
    toZip: projectToZip,
    zipName: 'blocks.zip',
    content,
    applied: (p) => `Custom Blocks übernommen (${p.list.length} Tile(s))`,
    docs: 'blocks',
  }, onDirty, changed);
  return { ...pane, tile: () => tile, setTile: (t) => { tile = t; pane.render(); } };
}
