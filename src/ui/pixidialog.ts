// Custom sprites (PIXI format): the project dialog (list.txt entries, files, import/export of a PIXI
// folder as .zip, "Übernehmen") and the dialog adding a downloaded sprite package.

import type { App } from './app.ts';
import { h, modal, clear, toast, pickFile, downloadBytes, hexInput, select } from './dom.ts';
import { unzipSync } from 'fflate';
import { loadAsar } from '../core/asar.ts';
import type { ApplyResult } from '../core/patchapply.ts';
import type { PatchPackage } from '../core/patchpkg.ts';
import { hex } from '../core/names.ts';
import { definesButton } from './defineedit.ts';
import { map16Source } from '../core/render.ts';
import { EXT_TILES } from '../core/map16ext.ts';
import {
  loadPixiProject, savePixiProject, projectFromZip, projectToZip, spriteConfig, numberRange,
  FOLDER, KIND_LABEL, type PixiProject,
} from '../core/pixi.ts';
import { planPixiPackage, applyPixiPackage, hexNum } from '../core/pixipkg.ts';
import type { SpriteFolder } from '../core/pixirt.ts';

const KINDS = Object.keys(FOLDER) as SpriteFolder[];

function done(app: App): void {
  app.emu.syncRom();
  app.persist();
  app.openLevel(app.level.number);
  app.emit('patch');
}

function errorLog(log: HTMLElement, r: ApplyResult): void {
  clear(log);
  for (const m of r.errors) log.appendChild(h('div', { class: 'err' }, m));
  for (const m of r.warnings) log.appendChild(h('div', { class: 'hint' }, m));
}

export async function openPixiDialog(app: App, onDone?: () => void): Promise<void> {
  const body = h('div', { class: 'uber-dialog' }, h('p', { class: 'hint' }, 'Asar wird geladen …'));
  let proj: PixiProject;
  let dirty = false;
  const log = h('div', { class: 'patch-log' });
  modal('Custom Sprites', body, [
    { label: 'Schließen', onClick: () => { if (!dirty || body.dataset.warned) return true; body.dataset.warned = '1'; toast('Nicht übernommene Änderungen – erneut „Schließen“ verwirft sie.'); return false; } },
    { label: 'Übernehmen', primary: true, onClick: () => apply() },
  ]);
  try { await loadAsar(); proj = loadPixiProject(app.rom) ?? { files: new Map(), list: [] }; } catch (e) {
    clear(body).appendChild(h('p', { class: 'hint error' }, String(e instanceof Error ? e.message : e)));
    return;
  }
  const change = () => { dirty = true; delete body.dataset.warned; build(); };

  function apply(): boolean {
    if (app.dirty) app.saveLevel(true);
    const r = savePixiProject(app.rom, proj);
    errorLog(log, r);
    if (!r.ok) return false;
    done(app);
    toast(`Custom Sprites übernommen (${proj.list.length})${r.warnings.length ? ` – ${r.warnings.join(' ')}` : ''}`);
    onDone?.();
    return true;
  }

  function build(): void {
    let kind: SpriteFolder = 'sprites';
    let num = 0;
    const fileSel = h('span');
    let file = '';
    const filesFor = (k: SpriteFolder) => [...proj.files.keys()].filter((f) => f.startsWith(FOLDER[k]) && (k === 'sprites' || k === 'shooters' || k === 'generators' ? /\.(json|cfg)$/i.test(f) : /\.asm$/i.test(f) && !/_header\.asm$/i.test(f))).sort();
    const buildFiles = () => {
      const fs = filesFor(kind);
      file = fs[0] ?? '';
      const [lo, hi] = numberRange(kind);
      num = Math.max(lo, Math.min(hi, num));
      clear(fileSel).append(fs.length ? select(fs.map((f, i) => [i, f.slice(FOLDER[kind].length)] as [number, string]), 0, (i) => (file = fs[i])) : h('span', { class: 'hint' }, `keine Dateien in ${FOLDER[kind]}`));
    };
    const add = () => {
      if (!file) { toast('Zuerst Dateien hinzufügen.', 'error'); return; }
      const [lo, hi] = numberRange(kind);
      if (num < lo || num > hi) { toast(`${KIND_LABEL[kind]}: Nummer ${hex(lo, 2)}–${hex(hi, 2)}`, 'error'); return; }
      const level = (k: SpriteFolder) => k === 'sprites' || k === 'shooters' || k === 'generators';
      proj.list = proj.list.filter((e) => !(e.num === num && (e.kind === kind || (level(e.kind) && level(kind)))));
      proj.list.push({ kind, num, file });
      change();
    };
    const label = (e: { kind: SpriteFolder; file: string }) => {
      try { const c = spriteConfig(proj, { ...e, num: 0 }); return c.names[0]?.name ?? ''; } catch (err) { return `Fehler: ${err instanceof Error ? err.message : err}`; }
    };
    const asmOf = (e: { kind: SpriteFolder; file: string }) => { try { return spriteConfig(proj, { ...e, num: 0 }).asm ?? e.file; } catch { return e.file; } };
    const rows = [...proj.list].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.num - b.num).map((e) => h('tr', null,
      h('td', null, KIND_LABEL[e.kind]),
      h('td', { class: 'mono' }, hex(e.num, 2)),
      h('td', { class: proj.files.has(e.file) ? '' : 'err' }, e.file.slice(FOLDER[e.kind].length)),
      h('td', null, label(e)),
      h('td', null, definesButton(proj.files, asmOf(e), change), h('button', { class: 'icon-btn', title: 'Entfernen', onclick: () => { proj.list = proj.list.filter((x) => x !== e); change(); } }, '✕'))));
    let folder: SpriteFolder | 'routines' = 'sprites';
    const addFile = async () => {
      const f = await pickFile('.asm,.json,.cfg,.bin,.zip');
      if (!f) return;
      const data = new Uint8Array(await f.arrayBuffer());
      const dest = folder === 'routines' ? 'routines/' : FOLDER[folder];
      if (/\.zip$/i.test(f.name)) {
        // a whole PIXI folder (with list.txt) replaces the project, otherwise the files are added
        const all = unzipSync(data);
        if (Object.keys(all).some((k) => /(^|\/)list\.txt$/i.test(k))) { proj = projectFromZip(data); toast(`PIXI-Ordner „${f.name}“ geladen`); }
        else for (const [p, c] of Object.entries(all)) if (!p.endsWith('/')) proj.files.set(dest + p.split('/').pop(), c);
      } else proj.files.set(dest + f.name, data);
      change();
    };
    const other = [...proj.files.keys()].sort();
    clear(body).append(
      h('p', { class: 'hint' }, 'Custom Sprites im Format von PIXI: Sprites (00–BF), Shooter (C0–CF) und Generatoren (D0–DF) mit .json/.cfg, die übrigen Arten als .asm. Shared Routines wie %GetDrawInfo() sind eingebaut; eigene in routines/ haben Vorrang. Downloads von SMWCentral fügt man am einfachsten über Patches → Hinzufügen ein.'),
      h('div', { class: 'row' },
        h('button', { onclick: addFile }, 'PIXI-Ordner oder Dateien hinzufügen …'),
        select([...KINDS.map((k, i) => [i, FOLDER[k]] as [number, string]), [KINDS.length, 'routines/']], 0, (i) => (folder = i < KINDS.length ? KINDS[i] : 'routines')),
        h('button', { onclick: () => downloadBytes('pixi.zip', projectToZip(proj), 'application/zip') }, 'Exportieren (.zip)')),
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Art'), h('th', null, 'Nr.'), h('th', null, 'Datei'), h('th', null, 'Name'), h('th')), rows)
        : h('p', { class: 'hint' }, 'Noch keine Custom Sprites eingetragen.'),
      h('div', { class: 'row uber-add' },
        select(KINDS.map((k, i) => [i, KIND_LABEL[k]] as [number, string]), 0, (i) => { kind = KINDS[i]; num = numberRange(kind)[0]; buildFiles(); }),
        h('label', null, ' Nr. '), hexInput(num, 2, (v) => (num = v)),
        fileSel,
        h('button', { onclick: add }, 'Eintragen')),
      h('h3', null, 'Projektdateien'),
      h('div', { class: 'uber-files' }, other.length ? other.map((f) => h('div', { class: 'row' }, h('span', { class: 'mono' }, f),
        definesButton(proj.files, f, change),
        h('button', { class: 'icon-btn', title: 'Datei löschen', onclick: () => { proj.files.delete(f); change(); } }, '✕'))) : h('p', { class: 'hint' }, 'Keine Dateien.')),
      dirty ? h('p', { class: 'hint' }, 'Nicht übernommene Änderungen.') : '',
      log,
    );
    buildFiles();
  }
  build();
}

// a downloaded package: numbers for its sprites, tiles for its blocks, linked defines – then added
export function openPixiPackageDialog(app: App, pkg: PatchPackage, onDone: () => void): void {
  let plan;
  try { plan = planPixiPackage(app.rom, pkg); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); return; }
  if (!plan.sprites.length) { toast(`„${pkg.name}“: keine Custom Sprites gefunden`, 'error'); return; }
  const p = plan;
  const log = h('div');
  const links = h('div');
  const showLinks = () => clear(links).append(...p.links.map((l) => h('div', { class: 'hint' },
    `!${l.define} in ${l.file.split('/').pop()} = ${hexNum(p.sprites[l.sprite].num)} (${KIND_LABEL[p.sprites[l.sprite].kind]} ${p.sprites[l.sprite].name})`)));
  showLinks();
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `„${pkg.name}“ enthält Custom Sprites im PIXI-Format${p.blocks.length ? ' und Custom Blocks, die sie benutzen' : ''}. Sie bekommen die nächsten freien Nummern:`),
    h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Art'), h('th', null, 'Datei'), h('th', null, 'Name'), h('th', null, 'Nr.')),
      p.sprites.map((s) => {
        const [lo, hi] = numberRange(s.kind);
        return h('tr', null, h('td', null, KIND_LABEL[s.kind]), h('td', null, s.file.split('/').pop()), h('td', null, s.name),
          h('td', null, hexInput(s.num, 2, (v) => { if (v < lo || v > hi) { toast(`${KIND_LABEL[s.kind]}: Nummer ${hex(lo, 2)}–${hex(hi, 2)}`, 'error'); return; } s.num = v; showLinks(); })));
      })),
    p.blocks.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Block'), h('th', null, 'Map16-Tile'), h('th', null, 'acts like')),
      p.blocks.map((b) => h('tr', null, h('td', null, b.file.split('/').pop()),
        h('td', null, hexInput(b.tile, 3, (v) => (b.tile = v), EXT_TILES - 1)),
        h('td', null, hexInput(b.acts, 3, (v) => (b.acts = v), 0x1ff))))) : '',
    p.links.length ? h('h3', null, 'Verknüpfte Einstellungen') : '', links,
    log);
  modal(`Custom Sprites hinzufügen: ${pkg.name}`, body, [
    { label: 'Abbrechen' },
    { label: 'Hinzufügen', primary: true, onClick: () => {
      if (app.dirty) app.saveLevel(true);
      const src = map16Source(app.rom, app.render);
      let r: ApplyResult;
      try { r = applyPixiPackage(app.rom, pkg, p, src.fg(0x025), (acts) => src.fg(acts)); } catch (e) {
        r = { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [], prints: [] };
      }
      if (!r.ok) { errorLog(log, r); return false; }
      done(app);
      const where = p.sprites.map((s) => `${KIND_LABEL[s.kind]} ${hex(s.num, 2)}`).join(', ');
      toast(`„${pkg.name}“ eingefügt: ${where}${p.blocks.length ? ` · Blöcke auf ${p.blocks.map((b) => hex(b.tile, 3)).join(', ')}` : ''}`);
      onDone();
      return true;
    } },
  ]);
}
