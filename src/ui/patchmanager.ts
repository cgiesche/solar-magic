// Patches of installed packages: the settings form (patch.json options, or the define assignments at the
// top of the main file) and reapplying a patch with new settings. Patch sources are kept with the editor
// data (rom.extra, older ones in IndexedDB) per registry entry; the ROM's registry alone suffices to
// remove a patch. Installing goes through the upload preview (upload.ts, core/packages.ts).

import type { App } from './app.ts';
import { h, modal, toast, logTool } from './dom.ts';
import type { ApplyResult } from '../core/patchapply.ts';
import { patchArchive, type PatchEntry } from '../core/patchreg.ts';
import { uploadFromFiles, effectiveDefines, optionDefault, unpackUpload, type StoredUpload, type Upload, type PatchOption } from '../core/patchpkg.ts';
import { reapplyPackagePatch as reapply } from '../core/packages.ts';
import { definesForm } from './defineedit.ts';
import { errorText } from './projectpane.ts';
import type { ToolKind } from '../core/parts.ts';
import type { Package } from '../core/pkgreg.ts';

export type { StoredUpload };
export async function storedUpload(app: App, p: PatchEntry): Promise<StoredUpload | undefined> {
  const a = patchArchive(app.rom, p);
  return a ? unpackUpload(a) : undefined;
}

export function toUpload(s: StoredUpload): Upload {
  return { ...uploadFromFiles(s.fileName, new Map(s.files)), main: s.main };
}

// settings form: manifest options, or the define assignments at the top of the main file
export function settingsForm(upload: Upload, main: string, values: Record<string, string>): { el: HTMLElement; read: () => Record<string, string> } {
  const opts = upload.manifest?.options;
  const wrap = (rows: HTMLElement[]) => h('div', { class: 'patch-settings' }, rows.length ? rows : h('p', { class: 'hint' }, 'No settings.'));
  if (!opts?.length) {
    const form = definesForm(new TextDecoder().decode(upload.files.get(main)!), values);
    return { el: wrap(form.rows), read: form.read };
  }
  const inputs: [string, () => string][] = [];
  const eff = effectiveDefines(upload, values);
  const el = wrap(opts.map((o) => optionRow(o, eff[o.define] ?? optionDefault(o), inputs)));
  return {
    el,
    read: () => {
      const out: Record<string, string> = {};
      for (const [name, get] of inputs) { const v = get(); if (v !== '') out[name] = v; }
      return out;
    },
  };
}

function optionRow(o: PatchOption, value: string, inputs: [string, () => string][]): HTMLElement {
  let control: HTMLElement;
  if (o.type === 'bool') {
    const c = h('input', { type: 'checkbox', checked: value === '1' });
    inputs.push([o.define, () => (c.checked ? '1' : '0')]);
    control = c;
  } else if (o.type === 'enum') {
    const s = h('select', null, (o.values ?? []).map((v) => h('option', { value: v.value, selected: v.value === value }, v.label)));
    inputs.push([o.define, () => s.value]);
    control = s;
  } else {
    const inp = h('input', { value, spellcheck: false, style: 'width: 10em' });
    inputs.push([o.define, () => {
      const v = inp.value.trim();
      if (o.type === 'hex') return '$' + v.replace(/^\$/, '').toUpperCase();
      return v;
    }]);
    control = inp;
  }
  return h('div', { class: 'prop' }, h('label', null, o.label), control, o.hint ? h('span', { class: 'hint' }, o.hint) : null);
}

// applies the patch of an installed package (`rec`; null: none) anew with other settings, as one undoable
// ROM edit with the package's record; the ROM changed when ok
export function reapplyPackagePatch(app: App, upload: Upload, fileName: string, main: string, values: Record<string, string>, entry: PatchEntry, rec: Package | null): ApplyResult {
  try {
    return app.romEdit(`Patch “${upload.name}” reapplied`, () => reapply(app.rom, entry.id, upload, fileName, main, values, rec));
  } catch (e) {
    return { ok: false, errors: [errorText(e)], warnings: [], prints: [] };
  }
}

export function patchDone(name: string, again: boolean, r: ApplyResult): void {
  toast(`Patch “${name}” ${again ? 'reapplied' : 'applied'}${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}`);
  logTool(`Patch “${name}”`, r);
}

// the tabs of the Packages dialog: the package list and the configuration view of each tool
export type PackagesTab = 'packages' | ToolKind | 'music';
