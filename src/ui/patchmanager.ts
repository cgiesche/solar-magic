// Patch manager: apply Asar patches (.asm or .zip) with settings, list, reconfigure and remove them.
// Sources are kept in IndexedDB per registry entry; the ROM's registry alone suffices to remove a patch.

import type { App } from './app.ts';
import { h, modal, clear, toast, pickFile } from './dom.ts';
import { kvGet, kvSet, kvDel } from './storage.ts';
import { loadAsar } from '../core/asar.ts';
import { applyPatch, uninstallPatch, reapplyPatch, type ApplyResult } from '../core/patchapply.ts';
import { listPatches, type PatchEntry } from '../core/patchreg.ts';
import { readPackage, packageFromFiles, scanDefines, effectiveDefines, packageSource, optionDefault, type PatchPackage, type PatchOption } from '../core/patchpkg.ts';
import { installEditorPatch } from '../core/patches.ts';
import { installMap16Ext, map16Ext } from '../core/map16ext.ts';
import { map16Source } from '../core/render.ts';

interface StoredPackage { fileName: string; files: [string, Uint8Array][]; main: string }
const srcKey = (id: string) => `patch:${id}`;

function toPackage(s: StoredPackage): PatchPackage {
  return { ...packageFromFiles(s.fileName, new Map(s.files)), main: s.main };
}

// ROM changed by a patch: reload everything that depends on it
function romChanged(app: App): void {
  app.emu.syncRom();
  app.persist();
  app.openLevel(app.level.number);
  app.emit('patch');
}

function logView(r: ApplyResult | null): HTMLElement {
  const el = h('div', { class: 'patch-log' });
  if (!r) return el;
  for (const e of r.errors) el.appendChild(h('div', { class: 'err' }, e));
  for (const w of r.warnings) el.appendChild(h('div', { class: 'warn' }, w));
  for (const p of r.prints) el.appendChild(h('div', null, p));
  return el;
}

// settings form: manifest options, or the define assignments at the top of the main file
function settingsForm(pkg: PatchPackage, main: string, values: Record<string, string>): { el: HTMLElement; read: () => Record<string, string> } {
  const inputs: [string, () => string][] = [];
  const rows: HTMLElement[] = [];
  const opts = pkg.manifest?.options;
  if (opts?.length) {
    const eff = effectiveDefines(pkg, values);
    for (const o of opts) rows.push(optionRow(o, eff[o.define] ?? optionDefault(o), inputs));
  } else {
    const defs = scanDefines(new TextDecoder().decode(pkg.files.get(main)!)).slice(0, 80);
    for (const d of defs) {
      const inp = h('input', { value: values[d.name] ?? d.value, spellcheck: false, style: 'width: 12em' });
      inputs.push([d.name, () => (inp.value.trim() === d.value ? '' : inp.value.trim())]);
      rows.push(h('div', { class: 'prop' }, h('label', { title: d.comment }, '!' + d.name), inp, d.comment ? h('span', { class: 'hint' }, d.comment) : null));
    }
  }
  const el = h('div', { class: 'patch-settings' }, rows.length ? rows : h('p', { class: 'hint' }, 'Keine Einstellungen.'));
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

function ensureRequirements(app: App, pkg: PatchPackage): void {
  for (const req of pkg.manifest?.requires ?? []) {
    if (req === 'smwe') installEditorPatch(app.rom);
    else if (req === 'smwx') { if (!map16Ext(app.rom)) installMap16Ext(app.rom, map16Source(app.rom, app.render).fg(0x025)); }
    else throw new Error(`Unbekannte Voraussetzung „${req}“ in patch.json`);
  }
}

// dialog for a new patch or new settings of an installed one
function openApplyDialog(app: App, pkg: PatchPackage, fileName: string, entry: PatchEntry | null, onDone: () => void): void {
  let main = pkg.main ?? pkg.asmFiles[0];
  const m = pkg.manifest;
  const info = h('div', null,
    m?.description ? h('p', null, m.description) : null,
    h('p', { class: 'hint' }, [m?.author && `von ${m.author}`, m?.version && `Version ${m.version}`, `${pkg.files.size} Datei(en)`].filter(Boolean).join(' · '),
      m?.smwc ? [' · ', h('a', { href: m.smwc, target: '_blank', rel: 'noopener' }, 'SMWCentral')] : null),
  );
  const settingsBox = h('div');
  let form = settingsForm(pkg, main, entry?.defines ?? {});
  settingsBox.appendChild(form.el);
  const mainSel = pkg.asmFiles.length > 1 && !m
    ? h('select', { onchange: (e: Event) => { main = (e.target as HTMLSelectElement).value; form = settingsForm(pkg, main, {}); clear(settingsBox).appendChild(form.el); } },
      pkg.asmFiles.map((f) => h('option', { value: f, selected: f === main }, f)))
    : null;
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    info,
    mainSel ? h('div', { class: 'prop' }, h('label', null, 'Hauptdatei'), mainSel) : null,
    !pkg.main && !entry ? h('p', { class: 'hint' }, 'Das Archiv enthält mehrere .asm-Dateien – bitte die Patch-Datei wählen (siehe Readme des Patches).') : null,
    h('h3', null, 'Einstellungen'),
    settingsBox,
    log,
  );
  const run = (): boolean => {
    const values = form.read();
    const src = packageSource(pkg, main, effectiveDefines(pkg, values));
    src.settings = values;
    if (app.dirty) app.saveLevel(true);
    let r: ApplyResult;
    try {
      ensureRequirements(app, pkg);
      r = entry ? reapplyPatch(app.rom, entry.id, src) : applyPatch(app.rom, src);
    } catch (e) {
      clear(log).appendChild(logView({ ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [], prints: [] }));
      return false;
    }
    if (!r.ok) { clear(log).appendChild(logView(r)); return false; }
    const stored: StoredPackage = { fileName, files: [...pkg.files], main };
    if (entry) kvDel(srcKey(entry.id)).catch(() => {});
    kvSet(srcKey(r.entry!.id), stored).catch(() => {});
    romChanged(app);
    toast(`Patch „${pkg.name}“ ${entry ? 'neu angewendet' : 'angewendet'}${r.warnings.length ? ` (${r.warnings.length} Warnung(en))` : ''}`);
    if (r.warnings.length || r.prints.length) modal(`Ausgabe: ${pkg.name}`, logView(r), [{ label: 'OK', primary: true }]);
    onDone();
    return true;
  };
  modal(`${entry ? 'Patch-Einstellungen' : 'Patch anwenden'}: ${pkg.name}`, body, [
    { label: 'Abbrechen' },
    { label: entry ? 'Neu anwenden' : 'Anwenden', primary: true, onClick: run },
  ]);
}

export async function openPatchManager(app: App): Promise<void> {
  const body = h('div', { class: 'patch-manager' });
  const build = () => {
    clear(body);
    const list = listPatches(app.rom);
    body.append(
      h('p', { class: 'hint' }, 'ASM-Patches (Asar-Format, z. B. von SMWCentral) als .asm oder .zip anwenden. Konflikte mit anderen Patches und den Editor-eigenen Patches werden erkannt; jeder Patch lässt sich wieder vollständig entfernen.'),
      list.length ? h('div', { class: 'patch-list' }, list.map((p) => {
        const bytes = p.segs.reduce((n, s) => n + s[1], 0);
        const own = p.own.reduce((n, o) => n + Math.max(0, app.rom.isRatsAt(o)), 0);
        return h('div', { class: 'patch-item' },
          h('div', null,
            h('div', { class: 'patch-name' }, p.name, p.version ? h('span', { class: 'hint' }, ` v${p.version}`) : null),
            h('div', { class: 'hint' }, `${new Date(p.applied).toLocaleString()} · ${bytes} Bytes geändert · ${(own / 1024).toFixed(1)} KB Code/Daten${Object.keys(p.defines).length ? ` · ${Object.entries(p.defines).map(([k, v]) => `!${k}=${v}`).join(' ')}` : ''}`)),
          h('div', { class: 'row' },
            h('button', { onclick: () => configure(p) }, 'Einstellungen …'),
            h('button', { onclick: () => remove(p) }, 'Entfernen')));
      })) : h('p', null, 'Keine Patches installiert.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: add }, 'Patch hinzufügen …')),
    );
  };
  const add = async () => {
    const f = await pickFile('.asm,.asar,.zip');
    if (!f) return;
    try {
      const pkg = readPackage(f.name, new Uint8Array(await f.arrayBuffer()));
      openApplyDialog(app, pkg, f.name, null, build);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const configure = async (p: PatchEntry) => {
    const s = await kvGet<StoredPackage>(srcKey(p.id));
    if (!s) { toast('Die Quelldateien dieses Patches sind nicht gespeichert – zum Ändern den Patch entfernen und neu hinzufügen.', 'error'); return; }
    openApplyDialog(app, toPackage(s), s.fileName, p, build);
  };
  const remove = (p: PatchEntry) => {
    if (app.dirty) app.saveLevel(true);
    try {
      const w = uninstallPatch(app.rom, p.id);
      kvDel(srcKey(p.id)).catch(() => {});
      romChanged(app);
      toast(`Patch „${p.name}“ entfernt${w.length ? ': ' + w.join(' ') : ''}`);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
    build();
  };
  body.appendChild(h('p', { class: 'hint' }, 'Asar wird geladen …'));
  modal('Patches', body, [{ label: 'Schließen', primary: true }]);
  try { await loadAsar(); } catch (e) { clear(body).appendChild(h('p', { class: 'hint error' }, `Asar konnte nicht geladen werden: ${e}`)); return; }
  build();
}
