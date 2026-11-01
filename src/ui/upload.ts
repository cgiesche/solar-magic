// The upload preview of the Packages dialog: what was detected in an upload (each part with its kind,
// the settings of a patch part, where blocks and graphics go – pkgplace.ts – and what is not installed) – or, when detection is ambiguous, the manual assignment prefilled with
// the suggestion – and "Install", which applies the whole package as one undoable ROM edit. Cancel
// leaves the ROM untouched.

import type { App } from './app.ts';
import { h, modal, clear, toast, logTool } from './dom.ts';
import { messageRoutineTaken } from '../core/messagedraw.ts';
import { installPackage, partsSummary, partLabel, type ReadyPreview, type ManualPreview, type InstallOptions } from '../core/packages.ts';
import { assignmentEditor } from './pkgmap.ts';
import type { Package } from '../core/pkgreg.ts';
import type { PartKind } from '../core/parts.ts';
import { map16Source } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { settingsForm } from './patchmanager.ts';
import { errorText } from './projectpane.ts';
import { docsButton } from './docview.ts';
import { musicPlayer } from './musicplayer.ts';
import { placementEditor } from './pkgplace.ts';
import { isObjectTextFile } from '../core/objtext.ts';

// done: after the package was installed
export function openUploadPreview(app: App, p: ReadyPreview | ManualPreview, done: (pkg: Package) => void): void {
  if (p.status === 'manual') { openManual(app, p, done); return; }
  const lvl = hex(app.level.number, 3);
  const has = (k: PartKind) => p.parts.some((x) => x.kind === k);
  // settings for a package's one patch (a Callisto project's are applied as its configuration has them)
  const patches = p.parts.filter((x) => x.kind === 'patch');
  const patch = patches.length === 1 && !p.callisto ? patches[0] : undefined;
  let main = patch?.file ?? '';
  const settingsBox = h('div');
  let form = patch ? settingsForm(p.upload!, main, {}) : null;
  if (form) settingsBox.appendChild(form.el);
  const log = h('div');
  const src = map16Source(app.rom, app.render);
  const place = placementEditor(app, p, src.fg(0x025));
  const defaults = [
    has('uberasm') ? `UberASM code runs in level ${lvl}` : '',
    has('music') ? `songs get the next free numbers and play in level ${lvl}` : '',
    has('sprite') ? 'sprites get the next free numbers' : '',
    has('sfx') ? 'sound effects keep the author’s numbers where free, else get the next free ones (the package’s code playing them follows)' : '',
  ].filter(Boolean);
  const textFiles = [...p.files.keys()].filter(isObjectTextFile).sort();
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `Found: ${partsSummary(p.parts)}.`),
    h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Part'), h('th', null, 'Name'), h('th', null, 'File')),
      p.parts.map((x) => h('tr', null, h('td', null, partLabel(x.kind)), h('td', null, x.name), h('td', { class: 'mono hint' }, x.file)))),
    docsButton(p.name, p.files),
    p.callisto ? h('p', { class: 'hint' }, `A Callisto project: its ${patches.length} patches are applied in the order of its patches.toml.`) : '',
    p.notes.map((n) => h('p', { class: 'hint' }, n)),
    textFiles.length ? h('p', { class: 'hint' }, `Object names and tooltips (Lunar Magic's): ${textFiles.join(', ')}.`) : '',
    p.unclaimed.length ? h('p', { class: 'hint' }, `Not installed: ${p.unclaimed.map((f) => f + (p.docs.includes(f) ? ' (manual)' : '')).join(', ')}.`) : '',
    defaults.length ? h('p', { class: 'hint' }, `Installing applies the whole package: ${defaults.join(', ')}. Assignments can be changed afterwards in the tabs.`) : '',
    patch && patch.candidates.length > 1 ? h('div', { class: 'prop' }, h('label', null, 'Main file'),
      h('select', { onchange: (e: Event) => { main = (e.target as HTMLSelectElement).value; form = settingsForm(p.upload!, main, {}); clear(settingsBox).appendChild(form.el); } },
        patch.candidates.map((f) => h('option', { value: f, selected: f === main }, f))),
      h('span', { class: 'hint' }, 'The upload has several .asm files – choose the patch file (see its readme).')) : '',
    place?.el ?? '',
    patch ? [h('h3', null, 'Patch settings'), settingsBox] : '',
    log,
  );
  installDialog(app, p, body, log, has('music') || has('sfx'), () => ({ patch: patch ? { main, values: form!.read() } : undefined, ...place?.read() }), done);
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
  choices: () => Pick<InstallOptions, 'patch' | 'assignment' | 'plan' | 'setup' | 'cgram' | 'sample' | 'samples'>, done: (pkg: Package) => void): void {
  let busy = false;
  const install = async () => {
    if (busy) return;
    busy = true;
    if (music) musicPlayer.stop();
    clear(log).appendChild(h('p', { class: 'hint' }, music ? 'Installing – AddmusicK is inserting the music …' : 'Installing …'));
    const src = map16Source(app.rom, app.render);
    // whether the game drew the messages before (known, or as last known for the patches then)
    const routineBefore = app.messageRoutine();
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
    // the sample level: a level edit of its own (not saved yet)
    const sample = r.sample;
    if (sample) app.replaceLevel(sample.level);
    const own = r.samples?.length ? `, its sample level(s) as level ${r.samples.map((n) => hex(n, 3)).join(', ')}` : '';
    toast(`“${p.name}” installed${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}${sample ? `, its sample level in place of level ${hex(app.level.number, 3)} (not saved yet)` : ''}${own} – Ctrl+Z undoes it.`);
    // a package that took over drawing the message boxes: said once that is known (checked in the probe worker)
    const name = r.pkg.name, rom = app.rom;
    void app.messageRoutineKnown().then((after) => {
      const note = app.rom === rom ? messageRoutineTaken(name, routineBefore, after) : null;
      if (note) toast(`“${name}”: ${note}`);
    });
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

// an upload of replaced patches only: the editor already does their work
export function showReplaced(name: string, notes: string[]): void {
  modal(`Upload: ${name}`, h('div', null, h('p', null, 'Nothing to install – the editor already does what this upload does.'), notes.map((n) => h('p', { class: 'hint' }, n))), [{ label: 'OK', primary: true }]);
}
