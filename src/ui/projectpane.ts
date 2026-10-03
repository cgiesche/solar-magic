// A tool project (UberASM, GPS blocks, PIXI sprites) as a tab of the patches dialog: the assignments,
// a bar for changes not applied yet, and below the project files, import/export of the tool folder and
// removing everything. Changes are staged in memory until "Übernehmen".

import type { App } from './app.ts';
import { h, clear, toast, pickFile, downloadBytes, select, choose, type Child } from './dom.ts';
import { unzipSync } from 'fflate';
import type { ApplyResult } from '../core/patchapply.ts';
import { definesButton, editButton } from './defineedit.ts';
import { keptDocsRow } from './docview.ts';

export interface Project { files: Map<string, Uint8Array> }

export interface PaneSpec<P extends Project> {
  title: string; // tab label, also in messages
  intro: string; // one line at the top
  format: string; // the file format, collapsed
  load(): P | null; // the ROM's project, null: none installed
  empty(): P;
  save(p: P): ApplyResult;
  remove(): string[];
  folders: string[]; // where single files can be added
  accept: string;
  addFile(p: P, folder: string, path: string, data: Uint8Array): void; // a file (or a file of a .zip) to `folder`
  fromZip(data: Uint8Array): P; // a whole tool folder
  toZip(p: P): Uint8Array;
  zipName: string;
  content(p: P, change: () => void): Child[]; // the assignments and the row to add one
  applied(p: P): string; // toast after "Übernehmen"
  docs: string; // tool key of the kept docs of packages added to the project (see docview.ts)
}

export interface Pane {
  title: string;
  el: HTMLElement;
  dirty(): boolean;
  apply(): boolean;
  discard(): void;
  reload(): void; // the ROM's project again, after it was changed outside the tab
  render(): void;
}

// ROM changed by a patch or project: reload everything that depends on it
export function romChanged(app: App): void {
  app.emu.syncRom();
  app.persist();
  app.openLevel(app.level.number);
  app.emit('patch');
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function logView(r: ApplyResult | null): HTMLElement {
  const el = h('div', { class: 'patch-log' });
  if (!r) return el;
  for (const e of r.errors) el.appendChild(h('div', { class: 'err' }, e));
  for (const w of r.warnings) el.appendChild(h('div', { class: 'warn' }, w));
  for (const p of r.prints) el.appendChild(h('div', null, p));
  return el;
}

// a .zip is a tool folder when it has a list.txt; otherwise its files are added one by one
const isToolFolder = (all: Record<string, Uint8Array>) => Object.keys(all).some((k) => /(^|\/)list\.txt$/i.test(k));

// onDirty: the dirty state changed (tab label); changed: after this tab changed the ROM (and romChanged)
export function projectPane<P extends Project>(app: App, spec: PaneSpec<P>, onDirty: () => void, changed: () => void): Pane & { project(): P } {
  const el = h('div', { class: 'project-pane' });
  let proj: P;
  let installed = false;
  let loadError = '';
  let dirty = false;
  let advanced = false;
  let fileFilter = '';
  let folder = spec.folders[0];
  const log = h('div', { class: 'patch-log' });

  const setDirty = (d: boolean) => { if (d !== dirty) { dirty = d; onDirty(); } };
  const change = () => { setDirty(true); render(); };
  const reload = () => {
    loadError = '';
    try {
      const p = spec.load();
      installed = !!p;
      proj = p ?? spec.empty();
    } catch (e) {
      loadError = errorText(e);
      installed = true;
      proj = spec.empty();
    }
    setDirty(false);
    clear(log);
    render();
  };

  const apply = (): boolean => {
    if (!dirty) return true;
    if (app.dirty) app.saveLevel(true);
    let r: ApplyResult;
    try { r = spec.save(proj); } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [] }; }
    clear(log).appendChild(logView({ ...r, warnings: r.ok ? [] : r.warnings, prints: [] }));
    if (!r.ok) return false;
    const text = spec.applied(proj);
    reload();
    romChanged(app);
    changed();
    toast(`${text}${r.warnings.length ? ` – ${r.warnings.join(' ')}` : ''}`);
    return true;
  };

  const addFile = async () => {
    const f = await pickFile(spec.accept + ',.zip');
    if (!f) return;
    const data = new Uint8Array(await f.arrayBuffer());
    try {
      if (/\.zip$/i.test(f.name)) {
        const all = unzipSync(data);
        if (isToolFolder(all)) { proj = spec.fromZip(data); toast(`${spec.title}-Ordner „${f.name}“ geladen – „Übernehmen“ wendet ihn an.`); }
        else for (const [p, c] of Object.entries(all)) if (!p.endsWith('/') && !p.startsWith('__MACOSX/')) spec.addFile(proj, folder, p.replace(/\\/g, '/').split('/').pop()!, c);
      } else spec.addFile(proj, folder, f.name, data);
    } catch (e) { toast(errorText(e), 'error'); return; }
    change();
  };

  const removeAll = async () => {
    const i = await choose(`${spec.title} entfernen`, `Alle ${spec.title} samt Projektdateien aus der ROM entfernen? Wer sie später noch braucht, exportiert sie vorher als .zip.`,
      [{ label: 'Abbrechen' }, { label: 'Entfernen', danger: true }]);
    if (i !== 1) return;
    if (app.dirty) app.saveLevel(true);
    try {
      const w = spec.remove();
      reload();
      romChanged(app);
      changed();
      toast(`${spec.title} entfernt${w.length ? ': ' + w.join(' ') : ''}`);
    } catch (e) { toast(errorText(e), 'error'); }
  };

  function render(): void {
    if (loadError) {
      clear(el).append(h('p', { class: 'hint error' }, loadError),
        h('div', { class: 'row' }, h('button', { class: 'danger', onclick: removeAll }, 'Alles entfernen …')));
      return;
    }
    const files = [...proj.files.keys()].filter((f) => f !== 'list.txt').sort();
    const shown = (f: string) => f.toLowerCase().includes(fileFilter.trim().toLowerCase());
    const adv = h('details', { class: 'pane-adv', open: advanced, ontoggle: () => (advanced = adv.open) },
      h('summary', null, `Projektdateien (${files.length}), Import/Export`),
      files.length > 12 ? h('input', { type: 'search', class: 'define-search', placeholder: 'Dateien filtern …', value: fileFilter, oninput: (e: Event) => {
        fileFilter = (e.target as HTMLInputElement).value;
        for (const r of adv.querySelectorAll<HTMLElement>('.uber-files > .row')) r.style.display = shown(r.dataset.path!) ? '' : 'none';
      } }) : null,
      h('div', { class: 'uber-files' }, files.length ? files.map((f) => h('div', { class: 'row', 'data-path': f, style: shown(f) ? '' : 'display: none' },
        h('span', { class: 'mono grow' }, f),
        definesButton(proj.files, f, change),
        editButton(proj.files, f, change),
        h('button', { class: 'icon-btn', title: 'Datei löschen', onclick: () => { proj.files.delete(f); change(); } }, '✕'))) : h('p', { class: 'hint' }, 'Keine Dateien.')),
      h('div', { class: 'row' },
        h('span', null, 'Nach'),
        select(spec.folders.map((f, i) => [i, f] as [number, string]), spec.folders.indexOf(folder), (i) => (folder = spec.folders[i])),
        h('button', { onclick: addFile, title: `Einzelne Dateien in den Ordner – oder ein ganzer ${spec.title}-Ordner als .zip (mit list.txt), der das Projekt ersetzt` }, 'Datei oder Ordner (.zip) hinzufügen …')),
      h('div', { class: 'row' },
        h('button', { onclick: () => downloadBytes(spec.zipName, spec.toZip(proj), 'application/zip') }, `Als ${spec.title}-Ordner exportieren (.zip)`),
        installed ? h('button', { class: 'danger', onclick: removeAll }, 'Alles entfernen …') : null),
    );
    clear(el).append(
      h('p', { class: 'hint' }, spec.intro, ' ', h('details', { class: 'inline-details' }, h('summary', null, 'Format'), h('div', null, spec.format))),
      h('div', { class: 'pane-content' }, spec.content(proj, change)),
      keptDocsRow(spec.docs),
      dirty ? h('div', { class: 'pending-bar' }, h('span', { class: 'grow' }, 'Nicht übernommene Änderungen'),
        h('button', { onclick: reload }, 'Verwerfen'),
        h('button', { class: 'primary', onclick: apply }, 'Übernehmen')) : '',
      log,
      adv,
    );
  }

  reload();
  return { title: spec.title, el, dirty: () => dirty, apply, discard: reload, reload, render, project: () => proj };
}
