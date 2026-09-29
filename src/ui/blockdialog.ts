// Custom blocks dialog (GPS format): assign block .asm files to Map16 tiles (with optional acts like),
// manage blocks/ and routines/, import/export a GPS folder (.zip). Applied with "Übernehmen".

import type { App } from './app.ts';
import { h, modal, clear, toast, pickFile, downloadBytes, hexInput, select } from './dom.ts';
import { unzipSync } from 'fflate';
import { loadAsar } from '../core/asar.ts';
import { loadBlockProject, saveBlockProject, projectFromZip, projectToZip, blockFiles, blocksEntry, type BlockProject } from '../core/blocks.ts';
import { EXT_TILES } from '../core/map16ext.ts';
import { map16Source } from '../core/render.ts';
import { hex } from '../core/names.ts';
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

export async function openBlockDialog(app: App, tile = 0x200, onDone?: () => void): Promise<void> {
  const body = h('div', { class: 'uber-dialog' }, h('p', { class: 'hint' }, 'Asar wird geladen …'));
  let proj: BlockProject;
  let dirty = false;
  const log = h('div', { class: 'patch-log' });
  modal('Custom Blocks', body, [
    { label: 'Schließen', onClick: () => { if (!dirty || body.dataset.warned) return true; body.dataset.warned = '1'; toast('Nicht übernommene Änderungen – erneut „Schließen“ verwirft sie.'); return false; } },
    { label: 'Übernehmen', primary: true, onClick: () => apply() },
  ]);
  try { await loadAsar(); proj = loadBlockProject(app.rom) ?? { files: new Map(), list: [] }; } catch (e) {
    clear(body).appendChild(h('p', { class: 'hint error' }, String(e instanceof Error ? e.message : e)));
    return;
  }
  const change = () => { dirty = true; delete body.dataset.warned; build(); };

  function apply(): boolean {
    if (app.dirty) app.saveLevel(true);
    const r = saveBlockProject(app.rom, proj, map16Source(app.rom, app.render).fg(0x025));
    clear(log);
    for (const m of r.errors) log.appendChild(h('div', { class: 'err' }, m));
    if (!r.ok) return false;
    cache = null;
    app.emu.syncRom();
    app.persist();
    app.openLevel(app.level.number);
    app.emit('patch');
    toast(`Custom Blocks übernommen (${proj.list.length} Tile(s))${r.warnings.length ? ` – ${r.warnings.join(' ')}` : ''}`);
    onDone?.();
    return true;
  }

  function build(): void {
    const files = blockFiles(proj.files);
    let file = files[0] ?? '';
    const actsIn = h('input', { placeholder: 'acts like (optional)', spellcheck: false, style: 'width: 9em' });
    const add = () => {
      if (!file) { toast('Zuerst eine Block-Datei hinzufügen.', 'error'); return; }
      const a = actsIn.value.trim();
      const acts = a ? parseInt(a, 16) : -1;
      if (a && (Number.isNaN(acts) || acts < 0 || acts > 0x1ff)) { toast('acts like muss 000–1FF sein', 'error'); return; }
      proj.list = proj.list.filter((b) => b.tile !== tile);
      proj.list.push({ tile, file, acts: acts >= 0 ? acts : undefined });
      change();
    };
    const rows = [...proj.list].sort((a, b) => a.tile - b.tile).map((b) => h('tr', null,
      h('td', { class: 'mono' }, hex(b.tile, 3)),
      h('td', { class: proj.files.has(b.file) ? '' : 'err' }, b.file.replace(/^blocks\//, '')),
      h('td', { class: 'mono' }, b.acts !== undefined ? hex(b.acts, 3) : '–'),
      h('td', null, h('button', { class: 'icon-btn', title: 'Entfernen', onclick: () => { proj.list = proj.list.filter((x) => x !== b); change(); } }, '✕'))));
    const other = [...proj.files.keys()].sort();
    let folder = 'blocks/';
    const addFile = async () => {
      const f = await pickFile('.asm,.zip');
      if (!f) return;
      const data = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name)) {
        // a whole GPS folder (with list.txt) replaces the project, otherwise the files are added
        const all = unzipSync(data);
        if (Object.keys(all).some((k) => /(^|\/)list\.txt$/i.test(k))) { proj = projectFromZip(data); toast(`GPS-Ordner „${f.name}“ geladen`); }
        else for (const [p, c] of Object.entries(all)) if (/\.asm$/i.test(p)) proj.files.set(folder + p.split('/').pop(), c);
      } else proj.files.set(folder + f.name, data);
      change();
    };
    clear(body).append(
      h('p', { class: 'hint' }, 'Blöcke im GPS-Format („db $42“/„db $37“ und eine JMP-Tabelle mit MarioBelow, MarioAbove, MarioSide, SpriteV, SpriteH, MarioCape, MarioFireball, TopCorner, BodyInside, HeadInside [, WallFeet, WallBody]). Shared Routines aus routines/ werden als %name() aufgerufen. Das Verhalten ohne eigenen Code bestimmt „acts like“.'),
      h('div', { class: 'row' },
        h('button', { onclick: addFile }, 'GPS-Ordner oder Dateien hinzufügen …'),
        select([[0, 'blocks/'], [1, 'routines/']], 0, (i) => (folder = i ? 'routines/' : 'blocks/')),
        h('button', { onclick: () => downloadBytes('blocks.zip', projectToZip(proj), 'application/zip') }, 'Exportieren (.zip)')),
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Tile'), h('th', null, 'Block'), h('th', null, 'acts like'), h('th')), rows)
        : h('p', { class: 'hint' }, 'Noch keine Blöcke zugeordnet.'),
      h('div', { class: 'row uber-add' },
        h('label', null, 'Tile '), hexInput(tile, 3, (v) => (tile = v), EXT_TILES - 1),
        files.length ? select(files.map((f, i) => [i, f.slice(7)] as [number, string]), 0, (i) => (file = files[i])) : h('span', { class: 'hint' }, 'keine Dateien in blocks/'),
        actsIn,
        h('button', { onclick: add }, 'Zuordnen')),
      h('h3', null, 'Projektdateien'),
      h('div', { class: 'uber-files' }, other.length ? other.map((f) => h('div', { class: 'row' }, h('span', { class: 'mono' }, f),
        h('button', { class: 'icon-btn', title: 'Datei löschen', onclick: () => { proj.files.delete(f); change(); } }, '✕'))) : h('p', { class: 'hint' }, 'Keine Dateien.')),
      dirty ? h('p', { class: 'hint' }, 'Nicht übernommene Änderungen.') : '',
      log,
    );
  }
  build();
}
