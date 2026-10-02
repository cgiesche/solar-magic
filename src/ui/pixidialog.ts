// Custom sprites (PIXI format): the tab of the patches dialog (list.txt entries, files, import/export
// of a PIXI folder as .zip) and the dialog adding a downloaded sprite package.

import type { App } from './app.ts';
import { h, modal, clear, toast, hexInput, select, type Child } from './dom.ts';
import { projectPane, logView, romChanged, type Pane } from './projectpane.ts';
import type { ApplyResult } from '../core/patchapply.ts';
import type { PatchPackage } from '../core/patchpkg.ts';
import { hex } from '../core/names.ts';
import { definesButton } from './defineedit.ts';
import { map16Source } from '../core/render.ts';
import { EXT_TILES } from '../core/map16ext.ts';
import {
  loadPixiProject, savePixiProject, projectFromZip, projectToZip, spriteConfig, numberRange, removePixi,
  FOLDER, KIND_LABEL, type PixiProject,
} from '../core/pixi.ts';
import { planPixiPackage, applyPixiPackage, hexNum } from '../core/pixipkg.ts';
import type { SpriteFolder } from '../core/pixirt.ts';

const KINDS = Object.keys(FOLDER) as SpriteFolder[];

function errorLog(log: HTMLElement, r: ApplyResult): void {
  clear(log).appendChild(logView({ ...r, prints: [] }));
}

export function pixiPane(app: App, onDirty: () => void, changed: () => void): Pane {
  let kind: SpriteFolder = 'sprites';
  let num = 0;

  function content(proj: PixiProject, change: () => void): Child[] {
    const filesFor = (k: SpriteFolder) => [...proj.files.keys()].filter((f) => f.startsWith(FOLDER[k]) && (k === 'sprites' || k === 'shooters' || k === 'generators' ? /\.(json|cfg)$/i.test(f) : /\.asm$/i.test(f) && !/_header\.asm$/i.test(f))).sort();
    const fileSel = h('span');
    let file = '';
    const numIn = hexInput(num, 2, (v) => (num = v));
    const addBtn = h('button', { onclick: () => add() }, 'Zuordnen');
    const buildFiles = () => {
      const fs = filesFor(kind);
      file = fs[0] ?? '';
      const [lo, hi] = numberRange(kind);
      num = Math.max(lo, Math.min(hi, num));
      numIn.value = hex(num, 2);
      numIn.title = `${KIND_LABEL[kind]}: ${hex(lo, 2)}–${hex(hi, 2)}`;
      addBtn.disabled = !fs.length;
      clear(fileSel).append(fs.length ? select(fs.map((f, i) => [i, f.slice(FOLDER[kind].length)] as [number, string]), 0, (i) => (file = fs[i])) : h('span', { class: 'hint' }, `keine Dateien in ${FOLDER[kind]}`));
    };
    const add = () => {
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
      h('td', { class: proj.files.has(e.file) ? '' : 'err', title: proj.files.has(e.file) ? e.file : `${e.file} fehlt im Projekt` }, e.file.slice(FOLDER[e.kind].length)),
      h('td', null, label(e)),
      h('td', { class: 'actions' }, definesButton(proj.files, asmOf(e), change), h('button', { class: 'icon-btn', title: 'Eintrag entfernen', onclick: () => { proj.list = proj.list.filter((x) => x !== e); change(); } }, '✕'))));
    const out = [
      rows.length ? h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Art'), h('th', null, 'Nr.'), h('th', null, 'Datei'), h('th', null, 'Name'), h('th')), rows)
        : h('p', { class: 'hint' }, 'Noch keine Custom Sprites – „Hinzufügen …“ oben nimmt einen Sprite-Download (.zip/.asm) und gibt ihm die nächste freie Nummer.'),
      proj.files.size ? h('div', { class: 'row uber-add' },
        select(KINDS.map((k, i) => [i, KIND_LABEL[k]] as [number, string]), KINDS.indexOf(kind), (i) => { kind = KINDS[i]; num = numberRange(kind)[0]; buildFiles(); }),
        h('label', null, 'Nr.'), numIn,
        fileSel,
        addBtn) : '',
    ];
    buildFiles();
    return out;
  }

  return projectPane<PixiProject>(app, {
    title: 'Custom Sprites',
    intro: 'Sprites, Shooter, Generatoren und die übrigen Sprite-Arten von PIXI.',
    format: 'Format von PIXI: Sprites (00–BF), Shooter (C0–CF) und Generatoren (D0–DF) mit .json/.cfg, die übrigen Arten als .asm. Shared Routines wie %GetDrawInfo() sind eingebaut; eigene in routines/ haben Vorrang.',
    load: () => loadPixiProject(app.rom),
    empty: () => ({ files: new Map(), list: [] }),
    save: (p) => savePixiProject(app.rom, p),
    remove: () => removePixi(app.rom),
    folders: [...KINDS.map((k) => FOLDER[k]), 'routines/'],
    accept: '.asm,.json,.cfg,.bin',
    addFile: (p, folder, path, data) => p.files.set(folder + path, data),
    fromZip: projectFromZip,
    toZip: projectToZip,
    zipName: 'pixi.zip',
    content,
    applied: (p) => `Custom Sprites übernommen (${p.list.length})`,
  }, onDirty, changed);
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
      romChanged(app);
      const where = p.sprites.map((s) => `${KIND_LABEL[s.kind]} ${hex(s.num, 2)}`).join(', ');
      toast(`„${pkg.name}“ eingefügt: ${where}${p.blocks.length ? ` · Blöcke auf ${p.blocks.map((b) => hex(b.tile, 3)).join(', ')}` : ''}`);
      onDone();
      return true;
    } },
  ]);
}
