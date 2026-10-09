// A tool project (UberASM, GPS blocks, PIXI sprites) as a configuration view of the Packages dialog: it
// assigns and unassigns what installed packages brought (each item names its package), and shows the
// project files with their settings and the export of the tool folder. It never adds content and never
// deletes a part – that is what uploading and removing packages do. Every change is written to the ROM
// at once as one undoable ROM edit (ADR 0001); nothing is staged.

import type { App } from './app.ts';
import { h, clear, toast, type Child } from './dom.ts';
import { downloadBytes } from './platform.ts';
import { listPackages, type Package } from '../core/pkgreg.ts';
import type { ApplyResult } from '../core/patchapply.ts';
import { definesButton, editButton } from './defineedit.ts';
import { manualsRow } from './docview.ts';

export interface Project { files: Map<string, Uint8Array> }

export interface PaneSpec<P extends Project> {
  title: string; // tab label, also in messages
  intro: string; // one line at the top
  format: string; // the file format, collapsed
  tool: 'uber' | 'blocks' | 'pixi'; // the field of a package record listing this project's files
  load(): P | null; // the ROM's project, null: none installed
  empty(): P;
  save(p: P): ApplyResult;
  toZip(p: P): Uint8Array;
  zipName: string;
  // the assignments and the row to assign; origin: the name of the package that brought a file
  content(p: P, change: () => void, origin: (file: string) => HTMLElement): Child[];
  applied(p: P): string; // toast after a change was applied
}

export interface Pane {
  title: string;
  el: HTMLElement;
  reload(): void; // the ROM's project again, after it was changed outside the tab
  render(): void;
  project(): Project; // the project as in the ROM
  touch(): void; // the project was changed from outside the tab: applied to the ROM at once
}

// after a ROM edit by a patch, project or package (romEdit told the editors): the level is loaded again
// from the ROM
export function patchesChanged(app: App): void {
  app.openLevel(app.level.number);
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


// changed: after this tab changed the ROM (and patchesChanged)
export function projectPane<P extends Project>(app: App, spec: PaneSpec<P>, changed: () => void): Pane & { project(): P } {
  const el = h('div', { class: 'project-pane' });
  let proj: P;
  let installed = false;
  let loadError = '';
  let advanced = false;
  let fileFilter = '';
  let packages: Package[] = [];
  const log = h('div', { class: 'patch-log' });
  // the package that brought a project file (the last one installed, if several did)
  const origin = (file: string): HTMLElement => {
    const r = packages.filter((x) => x[spec.tool].files.includes(file)).pop();
    return h('span', { class: r ? 'hint' : 'hint pkg-none', title: r ? `from the package “${r.name}”` : 'not from a package (added before packages were tracked)' }, r?.name ?? '–');
  };

  const reload = () => {
    loadError = '';
    try { packages = listPackages(app.rom); } catch { packages = []; }
    try {
      const p = spec.load();
      installed = !!p;
      proj = p ?? spec.empty();
    } catch (e) {
      loadError = errorText(e);
      installed = true;
      proj = spec.empty();
    }
    clear(log);
    render();
  };

  // the changed project into the ROM, one undo step with the editor data; a failed one leaves the ROM
  // as it was and the tab shows the ROM's project again
  const change = () => {
    if (app.dirty) app.saveLevel(true); // the level save is not part of the undo step
    let r: ApplyResult;
    const text = spec.applied(proj);
    try {
      r = app.romEdit(`${spec.title} changed`, () => {
        const before = app.rom.snapshot();
        let res: ApplyResult;
        try { res = spec.save(proj); } catch (e) { res = { ok: false, errors: [errorText(e)], warnings: [], prints: [] }; }
        if (!res.ok) app.rom.restore(before);
        return res;
      });
    } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [] }; }
    reload();
    if (!r.ok) {
      log.appendChild(logView({ ...r, prints: [] }));
      toast(`${spec.title}: not applied – ${r.errors[0] ?? 'error'}`, 'error');
      return;
    }
    patchesChanged(app);
    changed();
    toast(`${text}${r.warnings.length ? ` – ${r.warnings.join(' ')}` : ''}`);
  };

  function render(): void {
    if (loadError) {
      clear(el).append(h('p', { class: 'hint error' }, loadError));
      return;
    }
    const files = [...proj.files.keys()].filter((f) => f !== 'list.txt').sort();
    const shown = (f: string) => f.toLowerCase().includes(fileFilter.trim().toLowerCase());
    const adv = h('details', { class: 'pane-adv', open: advanced, ontoggle: () => (advanced = adv.open) },
      h('summary', null, `Project files (${files.length}), export`),
      files.length > 12 ? h('input', { type: 'search', class: 'define-search', placeholder: 'Filter files …', value: fileFilter, oninput: (e: Event) => {
        fileFilter = (e.target as HTMLInputElement).value;
        for (const r of adv.querySelectorAll<HTMLElement>('.uber-files > .row')) r.style.display = shown(r.dataset.path!) ? '' : 'none';
      } }) : null,
      h('div', { class: 'uber-files' }, files.length ? files.map((f) => h('div', { class: 'row', 'data-path': f, style: shown(f) ? '' : 'display: none' },
        h('span', { class: 'mono grow' }, f),
        origin(f),
        definesButton(proj.files, f, change),
        editButton(proj.files, f, change))) : h('p', { class: 'hint' }, 'No files – they come with packages (“Upload package …” above).')),
      installed ? h('div', { class: 'row' },
        h('button', { onclick: () => downloadBytes(spec.zipName, spec.toZip(proj), 'application/zip') }, `Export as ${spec.title} folder (.zip)`)) : '',
    );
    clear(el).append(
      h('p', { class: 'hint' }, spec.intro, ' ', h('details', { class: 'inline-details' }, h('summary', null, 'Format'), h('div', null, spec.format))),
      h('div', { class: 'pane-content' }, spec.content(proj, change, origin)),
      manualsRow(app.rom, spec.tool),
      log,
      adv,
    );
  }

  reload();
  return { title: spec.title, el, reload, render, project: () => proj, touch: change };
}
