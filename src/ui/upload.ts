// The upload preview of the Packages dialog: what was detected in an upload (each part with its kind,
// the settings of a patch part, where blocks and graphics go – pkgplace.ts – and what is not installed) – or, when detection is ambiguous, the manual assignment prefilled with
// the suggestion – and "Install", which applies the whole package as one undoable ROM edit. Cancel
// leaves the ROM untouched.

import type { App } from './app.ts';
import { h, modal, clear, toast, logTool } from './dom.ts';
import { installPackage, partsSummary, partLabel, type ReadyPreview, type ManualPreview, type InstallOptions } from '../core/packages.ts';
import { assignmentEditor } from './pkgmap.ts';
import type { Package } from '../core/pkgreg.ts';
import type { PartKind } from '../core/parts.ts';
import { map16Source } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { settingsForm } from './patchmanager.ts';
import { patchesChanged, errorText } from './projectpane.ts';
import { docsButton } from './docview.ts';
import { musicPlayer } from './musicplayer.ts';
import { placementEditor } from './pkgplace.ts';

// done: after the package was installed
export function openUploadPreview(app: App, p: ReadyPreview | ManualPreview, done: (pkg: Package) => void): void {
  if (p.status === 'manual') { openManual(app, p, done); return; }
  const lvl = hex(app.level.number, 3);
  const has = (k: PartKind) => p.parts.some((x) => x.kind === k);
  let main = p.patch?.main ?? '';
  const settingsBox = h('div');
  let form = p.patch ? settingsForm(p.patch.upload, main, {}) : null;
  if (form) settingsBox.appendChild(form.el);
  const log = h('div');
  const src = map16Source(app.rom, app.render);
  const place = placementEditor(app, p, src.fg(0x025));
  const defaults = [
    has('uberasm') ? `UberASM code runs in level ${lvl}` : '',
    has('music') ? `songs get the next free numbers and play in level ${lvl}` : '',
    has('sprite') ? 'sprites get the next free numbers' : '',
  ].filter(Boolean);
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `Found: ${partsSummary(p.parts)}.`),
    h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Part'), h('th', null, 'Name'), h('th', null, 'File')),
      p.parts.map((x) => h('tr', null, h('td', null, partLabel(x.kind)), h('td', null, x.name), h('td', { class: 'mono hint' }, x.file)))),
    docsButton(p.name, p.files),
    p.unclaimed.length ? h('p', { class: 'hint' }, `Not installed: ${p.unclaimed.map((f) => f + (p.docs.includes(f) ? ' (manual)' : '')).join(', ')}.`) : '',
    defaults.length ? h('p', { class: 'hint' }, `Installing applies the whole package: ${defaults.join(', ')}. Assignments can be changed afterwards in the tabs.`) : '',
    p.patch && p.patch.candidates.length > 1 ? h('div', { class: 'prop' }, h('label', null, 'Main file'),
      h('select', { onchange: (e: Event) => { main = (e.target as HTMLSelectElement).value; form = settingsForm(p.patch!.upload, main, {}); clear(settingsBox).appendChild(form.el); } },
        p.patch.candidates.map((f) => h('option', { value: f, selected: f === main }, f))),
      h('span', { class: 'hint' }, 'The upload has several .asm files – choose the patch file (see its readme).')) : '',
    place?.el ?? '',
    p.patch ? [h('h3', null, 'Patch settings'), settingsBox] : '',
    log,
  );
  installDialog(app, p, body, log, has('music'), () => ({ patch: p.patch ? { main, values: form!.read() } : undefined, ...place?.read() }), done);
}

// a package to assign by hand: the assignment, prefilled with the suggestion
function openManual(app: App, p: ManualPreview, done: (pkg: Package) => void): void {
  const editor = assignmentEditor(app, p);
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    h('div', { class: 'row' }, h('span', { class: 'grow hint' }, 'What goes where is usually in the package’s manual.'), docsButton(p.name, p.files)),
    editor.el,
    log);
  installDialog(app, p, body, log, false, () => ({ assignment: editor.read() }), done);
}

// the preview dialog with Install / Cancel; `choices`: what the user set in it
function installDialog(app: App, p: ReadyPreview | ManualPreview, body: HTMLElement, log: HTMLElement, music: boolean,
  choices: () => Pick<InstallOptions, 'patch' | 'assignment' | 'plan' | 'setup' | 'cgram' | 'sample'>, done: (pkg: Package) => void): void {
  let busy = false;
  const install = async () => {
    if (busy) return;
    busy = true;
    if (app.dirty) app.saveLevel(true); // the level save is not part of the undo step
    if (music) musicPlayer.stop();
    clear(log).appendChild(h('p', { class: 'hint' }, music ? 'Installing – AddmusicK is inserting the music …' : 'Installing …'));
    const src = map16Source(app.rom, app.render);
    let r;
    try {
      const opt: InstallOptions = { level: app.level.number, blank: src.fg(0x025), tileWords: (t) => src.fg(t), ...choices() };
      r = await app.romEditAsync(`Package “${p.name}” installed`, () => installPackage(app.rom, p, opt));
    } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [], pkg: null }; }
    busy = false;
    clear(log);
    logTool(`Package “${p.name}”`, r);
    if (!r.ok || !r.pkg) return;
    dlg.close(true);
    patchesChanged(app);
    // the sample level: a level edit of its own (not saved yet)
    const sample = r.sample;
    if (sample) {
      app.editLevel(() => { app.level = sample.level; }, false);
      app.selection.clear();
      app.changed();
    }
    app.emit('level-header'); // the level setup may have changed its graphics slots and colors
    app.palettesChanged();
    toast(`“${p.name}” installed${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}${sample ? `, its sample level in place of level ${hex(app.level.number, 3)} (not saved yet)` : ''} – Ctrl+Z undoes it.`);
    done(r.pkg);
  };
  const dlg = modal(`Upload: ${p.name}`, body, [
    { label: 'Cancel' },
    { label: 'Install', primary: true, onClick: () => { void install(); return false; } },
  ]);
}

// an upload that could not be recognized: what was found and what is missing
export function showUploadFailure(name: string, reason: string): void {
  modal(`Upload: ${name}`, h('div', null, h('p', null, 'This upload cannot be installed.'), h('p', { class: 'hint' }, reason)), [{ label: 'OK', primary: true }]);
}
