// Patch manager: apply Asar patches (.asm or .zip) with settings, list, reconfigure and remove them.
// Sources are kept in IndexedDB per registry entry; the ROM's registry alone suffices to remove a patch.

import type { App } from './app.ts';
import { h, modal, clear, toast, pickFile, hexInput, select } from './dom.ts';
import { kvGet, kvSet, kvDel } from './storage.ts';
import { loadAsar } from '../core/asar.ts';
import { applyPatch, uninstallPatch, reapplyPatch, type ApplyResult } from '../core/patchapply.ts';
import { listPatches, patchArchive, type PatchEntry } from '../core/patchreg.ts';
import { zipSync, unzipSync } from 'fflate';
import { openUberDialog } from './uberdialog.ts';
import { openBlockDialog } from './blockdialog.ts';
import { removeBlocks, loadBlockProject, saveBlockProject } from '../core/blocks.ts';
import { installVramPatch, uninstallVramPatch } from '../core/vrampatch.ts';
import { extGfxAvailable } from '../core/patches.ts';
import { loadProject, emptyProject, saveProject } from '../core/uberproject.ts';
import { ALL, type UberContext } from '../core/uberasm.ts';
import { hex } from '../core/names.ts';
import { planBlockPack, applyBlockPack } from '../core/blockpack.ts';
import { readPackage, packageFromFiles, detectKind, type PackageInfo, scanDefines, effectiveDefines, packageSource, optionDefault, type PatchPackage, type PatchOption } from '../core/patchpkg.ts';
import { installEditorPatch } from '../core/patches.ts';
import { installMap16Ext, map16Ext, setExtTileWords, EXT_FIRST, EXT_TILES } from '../core/map16ext.ts';
import { map16Source } from '../core/render.ts';

interface StoredPackage { fileName: string; files: [string, Uint8Array][]; main: string }
// sources up to this size (compressed) are kept in the ROM, larger ones only in the browser
const MAX_ROM_ARCHIVE = 256 << 10;
const META = '.smwe-package.json';

function packArchive(s: StoredPackage): Uint8Array {
  const files: Record<string, Uint8Array> = Object.fromEntries(s.files);
  files[META] = new TextEncoder().encode(JSON.stringify({ fileName: s.fileName, main: s.main }));
  return zipSync(files, { level: 9 });
}
function unpackArchive(a: Uint8Array): StoredPackage {
  const all = unzipSync(a);
  const meta = JSON.parse(new TextDecoder().decode(all[META])) as { fileName: string; main: string };
  delete all[META];
  return { ...meta, files: Object.entries(all) };
}
async function storedPackage(app: App, p: PatchEntry): Promise<StoredPackage | undefined> {
  const a = patchArchive(app.rom, p);
  return a ? unpackArchive(a) : kvGet<StoredPackage>(srcKey(p.id));
}
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
    const stored: StoredPackage = { fileName, files: [...pkg.files], main };
    const archive = packArchive(stored);
    if (archive.length <= MAX_ROM_ARCHIVE) src.archive = archive;
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
    if (entry) kvDel(srcKey(entry.id)).catch(() => {});
    if (!src.archive) kvSet(srcKey(r.entry!.id), stored).catch(() => {});
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

// files of a resource package for a tool folder: shared folders stay at the root, the rest goes into `folder`
function placeFiles(pkg: PatchPackage, main: string, mainText: string, folder: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [f, c] of pkg.files) {
    if (!/\.(asm|bin)$/i.test(f)) continue;
    const dest = /^(routines|library|other)\//.test(f) ? f : folder + f;
    out.set(dest, f === main ? new TextEncoder().encode(mainText) : c);
  }
  return out;
}

function resultLog(log: HTMLElement, r: ApplyResult): void {
  clear(log).appendChild(logView(r));
}

// an UberASM resource: choose where it runs, then add it to the ROM's UberASM project
function openUberResourceDialog(app: App, pkg: PatchPackage, info: PackageInfo, onDone: () => void): void {
  type Where = 'level' | 'all' | 'gamemode' | 'overworld';
  let where: Where = 'level';
  let num = app.level.number;
  const numBox = h('span');
  const buildNum = () => {
    const max = where === 'level' ? 0x1ff : where === 'gamemode' ? 0xff : 6;
    const digits = where === 'level' ? 3 : where === 'gamemode' ? 2 : 1;
    if (where === 'gamemode' && num > 0xff) num = 0x14;
    if (where === 'overworld') num = Math.min(num, 6);
    clear(numBox).append(where === 'all' ? '' : hexInput(Math.min(num, max), digits, (v) => (num = v), max));
  };
  const opts: [number, string][] = [[0, 'nur in Level'], [1, 'in allen Leveln'], [2, 'in Game Mode'], [3, 'auf Overworld-Karte']];
  const kinds: Where[] = ['level', 'all', 'gamemode', 'overworld'];
  const form = settingsForm(pkg, info.file, {});
  const log = h('div');
  buildNum();
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `„${pkg.name}“ ist eine UberASM-Ressource – Code, der jedes Frame läuft (Labels init/main/…), kein eigenständiger Patch. Wo soll er laufen?`),
    h('div', { class: 'row' }, select(opts, 0, (i) => { where = kinds[i]; buildNum(); }), numBox),
    h('p', { class: 'hint' }, '„In allen Leveln“ nutzt UberASMs Level-Eintrag „*“. Zuordnungen lassen sich später unter Patches → UberASM → Bearbeiten ändern.'),
    h('h3', null, 'Einstellungen'), form.el, log);
  modal(`UberASM-Code hinzufügen: ${pkg.name}`, body, [
    { label: 'Abbrechen' },
    { label: 'Hinzufügen', primary: true, onClick: () => {
      if (app.dirty) app.saveLevel(true);
      const ctx: UberContext = where === 'all' ? 'level' : where;
      const folder = `${ctx}/`;
      const text = packageSource(pkg, info.file, form.read()).files.get(info.file) as string;
      let r: ApplyResult;
      try {
        const proj = loadProject(app.rom) ?? emptyProject();
        for (const [f, c] of placeFiles(pkg, info.file, text, folder)) proj.files.set(f, c);
        const file = folder + info.file;
        const key = where === 'all' ? ALL : num;
        const calls = proj.list[ctx].get(key) ?? [];
        if (!calls.some((c) => c.file === file)) calls.push({ file, bytes: [] });
        proj.list[ctx].set(key, calls);
        r = saveProject(app.rom, proj);
      } catch (e) { r = { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [], prints: [] }; }
      if (!r.ok) { resultLog(log, r); return false; }
      romChanged(app);
      const place = where === 'all' ? 'allen Leveln' : where === 'level' ? `Level ${hex(num, 3)}` : where === 'gamemode' ? `Game Mode ${hex(num, 2)}` : `Overworld-Karte ${num}`;
      toast(`„${pkg.name}“ läuft jetzt in ${place} (UberASM).`);
      onDone();
      return true;
    } },
  ]);
}

// a GPS block: choose the Map16 tile, its acts like and graphics, then add it to the ROM's blocks
function openBlockResourceDialog(app: App, pkg: PatchPackage, info: PackageInfo, onDone: () => void): void {
  const proj = loadBlockProject(app.rom) ?? { files: new Map(), list: [] };
  const used = new Set(proj.list.map((b) => b.tile));
  let tile = EXT_FIRST;
  while (used.has(tile) && tile < EXT_TILES - 1) tile++;
  let acts = info.acts ?? 0x130;
  let gfxFrom = acts;
  const form = settingsForm(pkg, info.file, {});
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `„${pkg.name}“ ist ein Custom Block (GPS-Format). Er wird einem Map16-Tile zugeordnet; im Level platziert man ihn wie jedes Map16-Tile (Palette → Map16 bzw. Direct-Map16-Objekt).`),
    h('div', { class: 'prop' }, h('label', null, 'Map16-Tile'), hexInput(tile, 3, (v) => (tile = v), EXT_TILES - 1),
      h('span', { class: 'hint' }, 'Tiles ab 200 sind frei (erweiterte Map16-Seiten).')),
    h('div', { class: 'prop' }, h('label', null, 'Verhalten (acts like)'), hexInput(acts, 3, (v) => (acts = v), 0x1ff),
      h('span', { class: 'hint' }, info.acts !== undefined ? 'aus der Beschreibung des Blocks' : '130 = fester Block, 025 = Luft')),
    h('div', { class: 'prop' }, h('label', null, 'Grafik von Tile'), hexInput(gfxFrom, 3, (v) => (gfxFrom = v), EXT_TILES - 1),
      h('span', { class: 'hint' }, 'nur für neue Tiles ab 200; später im Map16-Editor änderbar')),
    h('h3', null, 'Einstellungen'), form.el, log);
  modal(`Custom Block hinzufügen: ${pkg.name}`, body, [
    { label: 'Abbrechen' },
    { label: 'Hinzufügen', primary: true, onClick: () => {
      if (app.dirty) app.saveLevel(true);
      const text = packageSource(pkg, info.file, form.read()).files.get(info.file) as string;
      const blank = map16Source(app.rom, app.render).fg(0x025);
      const words = map16Source(app.rom, app.render).fg(gfxFrom);
      let r: ApplyResult;
      try {
        for (const [f, c] of placeFiles(pkg, info.file, text, 'blocks/')) proj.files.set(f, c);
        proj.list = proj.list.filter((b) => b.tile !== tile);
        proj.list.push({ tile, file: 'blocks/' + info.file, acts });
        r = saveBlockProject(app.rom, proj, blank);
        if (r.ok && tile >= EXT_FIRST) setExtTileWords(app.rom, tile, words, blank);
      } catch (e) { r = { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [], prints: [] }; }
      if (!r.ok) { resultLog(log, r); return false; }
      romChanged(app);
      toast(`„${pkg.name}“ liegt auf Map16-Tile ${hex(tile, 3)}.`);
      onDone();
      return true;
    } },
  ]);
}

// a block package (list.txt + blocks, often .map16 and ExGFX): everything in one step
function openBlockPackDialog(app: App, pkg: PatchPackage, info: PackageInfo, onDone: () => void): void {
  const plan = planBlockPack(pkg, info.file);
  let map16At = plan.map16?.at ?? 0x200;
  let useLevel = true;
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `„${pkg.name}“ ist ein Block-Paket: Custom Blocks mit Tile-Liste${plan.map16 ? ', Map16-Grafik' : ''}${plan.gfx.length ? ' und Grafikdatei(en)' : ''}. Alles wird zusammen eingerichtet:`),
    h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Tile'), h('th', null, 'Block'), h('th', null, 'acts like')),
      plan.blocks.map((b) => h('tr', null, h('td', { class: 'mono' }, hex(b.tile, 3)), h('td', null, b.file.split('/').pop()), h('td', { class: 'mono' }, b.acts !== undefined ? hex(b.acts, 3) : '–')))),
    plan.missing.length ? h('p', { class: 'hint error' }, `Fehlt im Paket: ${plan.missing.join(', ')}`) : '',
    plan.map16 ? h('div', { class: 'prop' }, h('label', null, `Map16-Grafik (${plan.map16.file.split('/').pop()})`),
      h('span', null, `${plan.map16.data.tiles.length} Tile(s) ab `), hexInput(map16At, 3, (v) => (map16At = v), EXT_TILES - 1)) : '',
    ...plan.gfx.map((g) => h('div', { class: 'prop' }, h('label', null, `Grafik (${g.file.split('/').pop()})`),
      h('span', null, 'als ExGFX '), hexInput(g.num, 2, (v) => (g.num = v), 0xff),
      g.slot ? h('span', { class: 'hint' }, ` für den ${g.slot}-Slot`) : '')),
    plan.gfx.some((g) => g.slot) ? h('label', { class: 'row small' },
      h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => (useLevel = (e.target as HTMLInputElement).checked) }),
      ` Grafik in Level ${hex(app.level.number, 3)} laden (für andere Level: Header → Grafik-Bypass)`) : '',
    h('p', { class: 'hint' }, 'Platzieren: Palette → Map16 bzw. Direct-Map16-Objekt mit dem jeweiligen Tile.'),
    log);
  modal(`Block-Paket: ${pkg.name}`, body, [
    { label: 'Abbrechen' },
    { label: 'Einrichten', primary: true, onClick: () => {
      if (app.dirty) app.saveLevel(true);
      // BG2/BG3 need the tilemaps moved out of VRAM $2000 first
      if (useLevel && plan.gfx.some((g) => g.slot === 'BG2' || g.slot === 'BG3') && !extGfxAvailable(app.rom)) {
        const v = installVramPatch(app.rom);
        if (!v.ok) { resultLog(log, v); return false; }
      }
      const r = applyBlockPack(app.rom, pkg, plan, { blank: map16Source(app.rom, app.render).fg(0x025), level: useLevel ? app.level.number : null, map16At });
      if (!r.ok) { resultLog(log, r); return false; }
      romChanged(app);
      toast(`„${pkg.name}“ eingerichtet: ${r.notes.join(' · ')}`);
      onDone();
      return true;
    } },
  ]);
}

export async function openPatchManager(app: App): Promise<void> {
  const body = h('div', { class: 'patch-manager' });
  const build = () => {
    clear(body);
    const list = listPatches(app.rom);
    body.append(
      h('p', { class: 'hint' }, '„Hinzufügen“ nimmt eine .asm- oder .zip-Datei (z. B. von SMWCentral) und erkennt, was sie ist: ein Patch wird direkt angewendet, UberASM-Code wird einem Level/Game Mode zugeordnet, ein Custom Block einem Map16-Tile. Konflikte werden geprüft; alles lässt sich wieder entfernen.'),
      list.length ? h('div', { class: 'patch-list' }, list.map((p) => {
        const bytes = p.segs.reduce((n, s) => n + s[1], 0);
        const own = p.own.reduce((n, o) => n + Math.max(0, app.rom.isRatsAt(o)), 0);
        return h('div', { class: 'patch-item' },
          h('div', null,
            h('div', { class: 'patch-name' }, p.name, p.version ? h('span', { class: 'hint' }, ` v${p.version}`) : null),
            h('div', { class: 'hint' }, `${new Date(p.applied).toLocaleString()} · ${bytes} Bytes geändert · ${own < 1024 ? `${own} Bytes` : `${(own / 1024).toFixed(1)} KB`} Code/Daten${Object.keys(p.defines).length ? ` · ${Object.entries(p.defines).map(([k, v]) => `!${k}=${v}`).join(' ')}` : ''}`)),
          h('div', { class: 'row' },
            p.kind === 'vram' ? h('span', { class: 'hint' }, 'Editor-Patch: Tilemaps für BG2/BG3 verlegt') :
              h('button', { onclick: () => (p.kind === 'uberasm' ? openUberDialog(app, build) : p.kind === 'blocks' ? openBlockDialog(app, 0x200, build) : configure(p)) }, p.kind && p.kind !== 'patch' ? 'Bearbeiten …' : 'Einstellungen …'),
            h('button', { onclick: () => remove(p) }, 'Entfernen')));
      })) : h('p', null, 'Keine Patches installiert.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: add }, 'Hinzufügen …'),
        list.some((p) => p.kind === 'uberasm') ? null : h('button', { onclick: () => openUberDialog(app, build) }, 'UberASM …'),
        list.some((p) => p.kind === 'blocks') ? null : h('button', { onclick: () => openBlockDialog(app, 0x200, build) }, 'Custom Blocks …')),
    );
  };
  const add = async () => {
    const f = await pickFile('.asm,.asar,.zip');
    if (!f) return;
    try {
      const pkg = readPackage(f.name, new Uint8Array(await f.arrayBuffer()));
      const info = detectKind(pkg);
      if (info.kind === 'uberasm') openUberResourceDialog(app, pkg, info, build);
      else if (info.kind === 'block') openBlockResourceDialog(app, pkg, info, build);
      else if (info.kind === 'blockpack') openBlockPackDialog(app, pkg, info, build);
      else if (info.kind === 'pixi') modal(`Custom Sprite: ${pkg.name}`, h('p', null, `„${pkg.name}“ ist ein Custom Sprite für PIXI (${info.file}). Custom Sprites werden vom Editor noch nicht unterstützt.`), [{ label: 'OK', primary: true }]);
      else openApplyDialog(app, pkg, f.name, null, build);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };
  const configure = async (p: PatchEntry) => {
    const s = await storedPackage(app, p);
    if (!s) { toast('Die Quelldateien dieses Patches sind nicht gespeichert – zum Ändern den Patch entfernen und neu hinzufügen.', 'error'); return; }
    openApplyDialog(app, toPackage(s), s.fileName, p, build);
  };
  const remove = (p: PatchEntry) => {
    if (app.dirty) app.saveLevel(true);
    try {
      const w = p.kind === 'blocks' ? removeBlocks(app.rom) : p.kind === 'vram' ? uninstallVramPatch(app.rom) : uninstallPatch(app.rom, p.id);
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
