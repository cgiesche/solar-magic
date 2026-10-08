// The upload preview of the Packages dialog: what was detected in an upload (each part with its kind,
// the settings of a patch part) and "Install", which applies the whole package as one undoable ROM edit.
// Cancel leaves the ROM untouched.

import type { App } from './app.ts';
import { h, modal, clear, toast } from './dom.ts';
import { installPackage, partsSummary, partLabel, type ReadyPreview } from '../core/packages.ts';
import type { Package } from '../core/pkgreg.ts';
import type { PartKind } from '../core/parts.ts';
import { map16Source } from '../core/render.ts';
import { hex } from '../core/names.ts';
import { settingsForm } from './patchmanager.ts';
import { romChanged, logView, errorText } from './projectpane.ts';
import { docsButton, keepDocs } from './docview.ts';
import { musicPlayer } from './musicplayer.ts';

// the tool whose kept docs list a package with parts of that kind (see docview.ts)
const DOCS: Partial<Record<PartKind, string>> = { uberasm: 'uber', block: 'blocks', sprite: 'sprites' };

// done: after the package was installed
export function openUploadPreview(app: App, p: ReadyPreview, done: (pkg: Package) => void): void {
  const lvl = hex(app.level.number, 3);
  const has = (k: PartKind) => p.parts.some((x) => x.kind === k);
  let main = p.patch?.main ?? '';
  const settingsBox = h('div');
  let form = p.patch ? settingsForm(p.patch.upload, main, {}) : null;
  if (form) settingsBox.appendChild(form.el);
  const log = h('div');
  const defaults = [
    has('uberasm') ? `UberASM code runs in level ${lvl}` : '',
    has('music') ? `songs get the next free numbers and play in level ${lvl}` : '',
    has('block') ? 'blocks go on the next free Map16 tiles from 200' : '',
    has('sprite') ? 'sprites get the next free numbers' : '',
  ].filter(Boolean);
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `Found: ${partsSummary(p.parts)}.`),
    h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Part'), h('th', null, 'Name'), h('th', null, 'File')),
      p.parts.map((x) => h('tr', null, h('td', null, partLabel(x.kind)), h('td', null, x.name), h('td', { class: 'mono hint' }, x.file)))),
    docsButton(p.name, p.files),
    defaults.length ? h('p', { class: 'hint' }, `Installing applies the whole package: ${defaults.join(', ')}. Assignments can be changed afterwards in the tabs.`) : '',
    p.patch && p.patch.candidates.length > 1 ? h('div', { class: 'prop' }, h('label', null, 'Main file'),
      h('select', { onchange: (e: Event) => { main = (e.target as HTMLSelectElement).value; form = settingsForm(p.patch!.upload, main, {}); clear(settingsBox).appendChild(form.el); } },
        p.patch.candidates.map((f) => h('option', { value: f, selected: f === main }, f))),
      h('span', { class: 'hint' }, 'The upload has several .asm files – choose the patch file (see its readme).')) : '',
    p.patch ? [h('h3', null, 'Patch settings'), settingsBox] : '',
    log,
  );
  let busy = false;
  const install = async () => {
    if (busy) return;
    busy = true;
    if (app.dirty) app.saveLevel(true); // the level save is not part of the undo step
    if (has('music')) musicPlayer.stop();
    clear(log).appendChild(h('p', { class: 'hint' }, has('music') ? 'Installing – AddmusicK is inserting the music …' : 'Installing …'));
    const src = map16Source(app.rom, app.render);
    let r;
    try {
      r = await app.romEditAsync(`Package “${p.name}” installed`, () => installPackage(app.rom, p, {
        level: app.level.number,
        blank: src.fg(0x025),
        tileWords: (t) => src.fg(t),
        patch: p.patch ? { main, values: form!.read() } : undefined,
      }));
    } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [], pkg: null }; }
    busy = false;
    if (!r.ok || !r.pkg) { clear(log).appendChild(logView(r)); return; }
    dlg.close(true);
    romChanged(app);
    for (const k of new Set(p.parts.map((x) => DOCS[x.kind]))) if (k) void keepDocs(k, p.name, p.files).catch(() => {});
    toast(`“${p.name}” installed${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''} – Ctrl+Z undoes it.`);
    if (r.warnings.length) modal(`Output: ${p.name}`, logView({ ...r, prints: [] }), [{ label: 'OK', primary: true }]);
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
