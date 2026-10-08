// Adding any upload, recognized as a patch, UberASM resource, block, block package, sprite
// package or Lunar Magic background, each with its dialog; applying Asar patches (.asm or .zip) with
// settings. Patch sources are kept with the editor data (rom.extra, older ones in IndexedDB) per registry entry; the ROM's
// registry alone suffices to remove a patch. What a package brings is kept as one (pkgtrack.ts).

import { openAddSongDialog } from './musicdialog.ts';
import { isSongText } from '../core/music.ts';
import type { App } from './app.ts';
import { h, modal, clear, toast, hexInput, select } from './dom.ts';
import { kvGet, kvDel } from './storage.ts';
import { applyPatch, reapplyPatch, type ApplyResult, type PatchSource } from '../core/patchapply.ts';
import { patchArchive, type PatchEntry } from '../core/patchreg.ts';
import { zipSync, unzipSync } from 'fflate';
import { pickFile } from './dom.ts';
import { openPixiUploadDialog } from './pixidialog.ts';
import { freeBlockTile } from './blockdialog.ts';
import { loadBlockProject, saveBlockProject } from '../core/blocks.ts';
import { installVramPatch } from '../core/vrampatch.ts';
import { extGfxAvailable } from '../core/patches.ts';
import { loadProject, emptyProject, saveProject } from '../core/uberproject.ts';
import { ALL, type UberContext } from '../core/uberasm.ts';
import { hex } from '../core/names.ts';
import { planBlockPack, applyBlockPack } from '../core/blockpack.ts';
import { isLevelImport, planBgPack, applyBgPack, levelColors, type BgPackResult } from '../core/bgpack.ts';
import { uploadFiles, uploadFromFiles, detectKind, type DetectedPart, effectiveDefines, uploadSource, optionDefault, type Upload, type PatchOption } from '../core/patchpkg.ts';
import { installEditorPatch } from '../core/patches.ts';
import { installMap16Ext, map16Ext, setExtTileWords, EXT_FIRST, EXT_TILES } from '../core/map16ext.ts';
import { map16Source } from '../core/render.ts';
import { definesForm } from './defineedit.ts';
import { openPkgMapDialog } from './pkgmap.ts';
import { docsButton, keepDocs } from './docview.ts';
import { suggestMapping } from '../core/pkgmap.ts';
import { romChanged, logView, errorText } from './projectpane.ts';
import { trackPackage, type Tracker } from './pkgtrack.ts';
import { TOOL_KINDS, type ToolKind } from '../core/parts.ts';

export interface StoredUpload { fileName: string; files: [string, Uint8Array][]; main: string }
const META = '.smwe-package.json';

function packArchive(s: StoredUpload): Uint8Array {
  const files: Record<string, Uint8Array> = Object.fromEntries(s.files);
  files[META] = new TextEncoder().encode(JSON.stringify({ fileName: s.fileName, main: s.main }));
  return zipSync(files, { level: 9 });
}
function unpackArchive(a: Uint8Array): StoredUpload {
  const all = unzipSync(a);
  const meta = JSON.parse(new TextDecoder().decode(all[META])) as { fileName: string; main: string };
  delete all[META];
  return { ...meta, files: Object.entries(all) };
}
export async function storedUpload(app: App, p: PatchEntry): Promise<StoredUpload | undefined> {
  const a = patchArchive(app.rom, p);
  return a ? unpackArchive(a) : kvGet<StoredUpload>(srcKey(p.id)); // older versions kept large sources in the browser
}
const srcKey = (id: string) => `patch:${id}`;

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

function ensureRequirements(app: App, upload: Upload): void {
  for (const req of upload.manifest?.requires ?? []) {
    if (req === 'smwe') installEditorPatch(app.rom);
    else if (req === 'smwx') { if (!map16Ext(app.rom)) installMap16Ext(app.rom, map16Source(app.rom, app.render).fg(0x025)); }
    else throw new Error(`Unknown requirement “${req}” in patch.json`);
  }
}

// applies the package's patch: new, or anew (`entry`) with other settings; the ROM changed when ok
export function runPatch(app: App, upload: Upload, fileName: string, main: string, values: Record<string, string>, entry: PatchEntry | null): ApplyResult {
  const fail = (e: unknown): ApplyResult => ({ ok: false, errors: [errorText(e)], warnings: [], prints: [] });
  let src: PatchSource;
  try { src = uploadSource(upload, main, effectiveDefines(upload, values)); } catch (e) { return fail(e); }
  src.settings = values;
  const stored: StoredUpload = { fileName, files: [...upload.files], main };
  src.archive = packArchive(stored); // kept with the editor data, not in the ROM
  if (app.dirty) app.saveLevel(true);
  let r: ApplyResult;
  try {
    ensureRequirements(app, upload);
    r = entry ? reapplyPatch(app.rom, entry.id, src) : applyPatch(app.rom, src);
  } catch (e) {
    return fail(e);
  }
  if (!r.ok) return r;
  if (entry) kvDel(srcKey(entry.id)).catch(() => {}); // sources older versions kept in the browser
  romChanged(app);
  return r;
}

export function patchDone(name: string, again: boolean, r: ApplyResult): void {
  toast(`Patch “${name}” ${again ? 'reapplied' : 'applied'}${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ''}`);
  if (r.warnings.length || r.prints.length) modal(`Output: ${name}`, logView(r), [{ label: 'OK', primary: true }]);
}

// dialog for a new patch or new settings of an installed one
function openApplyDialog(app: App, upload: Upload, fileName: string, entry: PatchEntry | null, onDone: () => void): void {
  let main = upload.main ?? upload.asmFiles[0];
  const m = upload.manifest;
  const info = h('div', null,
    m?.description ? h('p', null, m.description) : null,
    h('p', { class: 'hint' }, [m?.author && `by ${m.author}`, m?.version && `version ${m.version}`, `${upload.files.size} file(s)`].filter(Boolean).join(' · '),
      m?.smwc ? [' · ', h('a', { href: m.smwc, target: '_blank', rel: 'noopener' }, 'SMWCentral')] : null),
    docsButton(upload.name, upload.files),
  );
  const settingsBox = h('div');
  let form = settingsForm(upload, main, entry?.defines ?? {});
  settingsBox.appendChild(form.el);
  const mainSel = upload.asmFiles.length > 1 && !m
    ? h('select', { onchange: (e: Event) => { main = (e.target as HTMLSelectElement).value; form = settingsForm(upload, main, {}); clear(settingsBox).appendChild(form.el); } },
      upload.asmFiles.map((f) => h('option', { value: f, selected: f === main }, f)))
    : null;
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    info,
    mainSel ? h('div', { class: 'prop' }, h('label', null, 'Main file'), mainSel) : null,
    !upload.main && !entry ? h('p', { class: 'hint' }, 'The archive contains several .asm files – please choose the patch file (see the patch’s readme).') : null,
    h('h3', null, 'Settings'),
    settingsBox,
    log,
  );
  const run = (): boolean => {
    const r = runPatch(app, upload, fileName, main, form.read(), entry);
    if (!r.ok) { clear(log).appendChild(logView(r)); return false; }
    patchDone(upload.name, !!entry, r);
    onDone();
    return true;
  };
  modal(`${entry ? 'Patch settings' : 'Apply patch'}: ${upload.name}`, body, [
    { label: 'Cancel' },
    { label: entry ? 'Reapply' : 'Apply', primary: true, onClick: run },
  ]);
}

// files of a resource package for a tool folder: shared folders stay at the root, the rest goes into `folder`
function placeFiles(upload: Upload, main: string, mainText: string, folder: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [f, c] of upload.files) {
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
function openUberResourceDialog(app: App, upload: Upload, info: DetectedPart, preset: AddPreset, onDone: () => void): void {
  type Where = 'level' | 'all' | 'gamemode' | 'overworld';
  let where: Where = preset.uberContext;
  let num = where === 'level' ? app.level.number : where === 'gamemode' ? 0x14 : 0;
  const numBox = h('span');
  const buildNum = () => {
    const max = where === 'level' ? 0x1ff : where === 'gamemode' ? 0xff : 6;
    const digits = where === 'level' ? 3 : where === 'gamemode' ? 2 : 1;
    if (where === 'gamemode' && num > 0xff) num = 0x14;
    if (where === 'overworld') num = Math.min(num, 6);
    clear(numBox).append(where === 'all' ? '' : hexInput(Math.min(num, max), digits, (v) => (num = v), max));
  };
  const opts: [number, string][] = [[0, 'only in level'], [1, 'in all levels'], [2, 'in game mode'], [3, 'on overworld map']];
  const kinds: Where[] = ['level', 'all', 'gamemode', 'overworld'];
  const form = settingsForm(upload, info.file, {});
  const log = h('div');
  buildNum();
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `“${upload.name}” is an UberASM resource – code that runs every frame (labels init/main/…), not a standalone patch. Where should it run?`),
    docsButton(upload.name, upload.files),
    h('div', { class: 'row' }, select(opts, kinds.indexOf(where), (i) => { where = kinds[i]; buildNum(); }), numBox),
    h('p', { class: 'hint' }, '“In all levels” uses UberASM’s level entry “*”. Assignments can be changed later in the UberASM tab.'),
    h('h3', null, 'Settings'), form.el, log);
  modal(`Add UberASM code: ${upload.name}`, body, [
    { label: 'Cancel' },
    { label: 'Add', primary: true, onClick: () => {
      if (app.dirty) app.saveLevel(true);
      const ctx: UberContext = where === 'all' ? 'level' : where;
      const folder = `${ctx}/`;
      const text = uploadSource(upload, info.file, form.read()).files.get(info.file) as string;
      let r: ApplyResult;
      try {
        const proj = loadProject(app.rom) ?? emptyProject();
        for (const [f, c] of placeFiles(upload, info.file, text, folder)) proj.files.set(f, c);
        const file = folder + info.file;
        const key = where === 'all' ? ALL : num;
        const calls = proj.list[ctx].get(key) ?? [];
        if (!calls.some((c) => c.file === file)) calls.push({ file, bytes: [] });
        proj.list[ctx].set(key, calls);
        r = saveProject(app.rom, proj);
      } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [] }; }
      if (!r.ok) { resultLog(log, r); return false; }
      romChanged(app);
      void keepDocs('uber', upload.name, upload.files).catch(() => {});
      const place = where === 'all' ? 'all levels' : where === 'level' ? `level ${hex(num, 3)}` : where === 'gamemode' ? `game mode ${hex(num, 2)}` : `overworld map ${num}`;
      toast(`“${upload.name}” now runs in ${place} (UberASM).`);
      onDone();
      return true;
    } },
  ]);
}

// a GPS block: choose the Map16 tile, its acts like and graphics, then add it to the ROM's blocks
function openBlockResourceDialog(app: App, upload: Upload, info: DetectedPart, preset: AddPreset, onDone: () => void): void {
  const proj = loadBlockProject(app.rom) ?? { files: new Map(), list: [] };
  // the tile chosen in the blocks tab while it is free, otherwise the next free one
  let tile = proj.list.some((b) => b.tile === preset.tile) ? freeBlockTile(proj) : preset.tile;
  let acts = info.acts ?? 0x130;
  let gfxFrom = acts;
  const form = settingsForm(upload, info.file, {});
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    docsButton(upload.name, upload.files),
    h('p', null, `“${upload.name}” is a custom block (GPS format). It is assigned to a Map16 tile; in a level it is placed like any Map16 tile (palette → Map16, or a Direct Map16 object).`),
    h('div', { class: 'prop' }, h('label', null, 'Map16-Tile'), hexInput(tile, 3, (v) => (tile = v), EXT_TILES - 1),
      h('span', { class: 'hint' }, proj.list.length ? `Tiles from 200 on are free (extended Map16 pages); in use: ${proj.list.map((b) => hex(b.tile, 3)).join(', ')}` : 'Tiles from 200 on are free (extended Map16 pages).')),
    h('div', { class: 'prop' }, h('label', null, 'Behavior (acts like)'), hexInput(acts, 3, (v) => (acts = v), 0x1ff),
      h('span', { class: 'hint' }, info.acts !== undefined ? 'from the block’s description' : '130 = solid block, 025 = air')),
    h('div', { class: 'prop' }, h('label', null, 'Graphics from tile'), hexInput(gfxFrom, 3, (v) => (gfxFrom = v), EXT_TILES - 1),
      h('span', { class: 'hint' }, 'only for new tiles from 200 on; can be changed later in the Map16 editor')),
    h('h3', null, 'Settings'), form.el, log);
  modal(`Add custom block: ${upload.name}`, body, [
    { label: 'Cancel' },
    { label: 'Add', primary: true, onClick: () => {
      if (app.dirty) app.saveLevel(true);
      const text = uploadSource(upload, info.file, form.read()).files.get(info.file) as string;
      const blank = map16Source(app.rom, app.render).fg(0x025);
      const words = map16Source(app.rom, app.render).fg(gfxFrom);
      let r: ApplyResult;
      try {
        for (const [f, c] of placeFiles(upload, info.file, text, 'blocks/')) proj.files.set(f, c);
        proj.list = proj.list.filter((b) => b.tile !== tile);
        proj.list.push({ tile, file: 'blocks/' + info.file, acts });
        r = saveBlockProject(app.rom, proj, blank);
        if (r.ok && tile >= EXT_FIRST) setExtTileWords(app.rom, tile, words, blank);
      } catch (e) { r = { ok: false, errors: [errorText(e)], warnings: [], prints: [] }; }
      if (!r.ok) { resultLog(log, r); return false; }
      romChanged(app);
      void keepDocs('blocks', upload.name, upload.files).catch(() => {});
      toast(`“${upload.name}” is on Map16 tile ${hex(tile, 3)}.`);
      onDone();
      return true;
    } },
  ]);
}

// a block package (list.txt + blocks, often .map16 and ExGFX): everything in one step
function openBlockPackDialog(app: App, upload: Upload, info: DetectedPart, onDone: () => void): void {
  const plan = planBlockPack(upload, info.file);
  let map16At = plan.map16?.at ?? 0x200;
  let useLevel = true;
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    docsButton(upload.name, upload.files),
    h('p', null, `“${upload.name}” is a block package: custom blocks with a tile list${plan.map16 ? ', Map16 graphics' : ''}${plan.gfx.length ? ' and graphics file(s)' : ''}. Everything is set up together:`),
    h('table', { class: 'uber-table' }, h('tr', null, h('th', null, 'Tile'), h('th', null, 'Block'), h('th', null, 'acts like')),
      plan.blocks.map((b) => h('tr', null, h('td', { class: 'mono' }, hex(b.tile, 3)), h('td', null, b.file.split('/').pop()), h('td', { class: 'mono' }, b.acts !== undefined ? hex(b.acts, 3) : '–')))),
    plan.missing.length ? h('p', { class: 'hint error' }, `Missing from the package: ${plan.missing.join(', ')}`) : '',
    plan.map16 ? h('div', { class: 'prop' }, h('label', null, `Map16 graphics (${plan.map16.file.split('/').pop()})`),
      h('span', null, `${plan.map16.data.tiles.length} tile(s) from `), hexInput(map16At, 3, (v) => (map16At = v), EXT_TILES - 1)) : '',
    ...plan.gfx.map((g) => h('div', { class: 'prop' }, h('label', null, `Graphics (${g.file.split('/').pop()})`),
      h('span', null, 'as ExGFX '), hexInput(g.num, 2, (v) => (g.num = v), 0xff),
      g.slot ? h('span', { class: 'hint' }, ` for the ${g.slot} slot`) : '')),
    plan.gfx.some((g) => g.slot) ? h('label', { class: 'row small' },
      h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => (useLevel = (e.target as HTMLInputElement).checked) }),
      ` Load graphics in level ${hex(app.level.number, 3)} (for other levels: header → graphics bypass)`) : '',
    h('p', { class: 'hint' }, 'To place: palette → Map16, or a Direct Map16 object with the respective tile.'),
    log);
  modal(`Block package: ${upload.name}`, body, [
    { label: 'Cancel' },
    { label: 'Set up', primary: true, onClick: () => {
      if (app.dirty) app.saveLevel(true);
      // BG2/BG3 need the tilemaps moved out of VRAM $2000 first
      if (useLevel && plan.gfx.some((g) => g.slot === 'BG2' || g.slot === 'BG3') && !extGfxAvailable(app.rom)) {
        const v = installVramPatch(app.rom);
        if (!v.ok) { resultLog(log, v); return false; }
      }
      const r = applyBlockPack(app.rom, upload, plan, { blank: map16Source(app.rom, app.render).fg(0x025), level: useLevel ? app.level.number : null, map16At });
      if (!r.ok) { resultLog(log, r); return false; }
      romChanged(app);
      void keepDocs('blocks', upload.name, upload.files).catch(() => {});
      toast(`“${upload.name}” set up: ${r.notes.join(' · ')}`);
      onDone();
      return true;
    } },
  ]);
}

// a Lunar Magic graphics package (.mwl with .map16, ExGFX, .pal/.palmask): its background into the
// current level, its FG Map16 tiles to place, the graphics slots and colors they need
function openBgPackDialog(app: App, fileName: string, files: Map<string, Uint8Array>, onDone: () => void): void {
  const name = fileName.replace(/\.[^.]*$/, '').split(/[\\/]/).pop()!;
  const lvl = hex(app.level.number, 3);
  const blank = map16Source(app.rom, app.render).fg(0x025);
  const plan = planBgPack(app.rom, name, files, blank);
  const canBg = !!plan.level.bg && app.canEditBg();
  if (!canBg && !plan.fg) {
    modal(`Graphics: ${name}`, h('p', null, plan.level.bg
      ? `“${name}” is a background package (BG tilemap). But level ${lvl} has layer 2 objects instead of a BG background – open a level with a BG first.`
      : `“${name}” has neither a BG background nor FG Map16 tiles to take over.`), [{ label: 'OK', primary: true }]);
    return;
  }
  let at = plan.at, fgAt = plan.fgAt, useBg = canBg, useFg = !!plan.fg;
  const usePal = plan.palettes.map((p) => !p.layer3);
  const n16 = plan.map16 ? plan.map16.data.tiles.length : 0;
  const ext = plan.gfx.some((g) => g.slot === 'BG2' || g.slot === 'BG3');
  const file = (f: string) => f.split('/').pop()!;
  const check = (on: boolean, set: (v: boolean) => void, disabled = false) =>
    h('input', { type: 'checkbox', checked: on, disabled, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
  const log = h('div');
  const body = h('div', { class: 'patch-apply' },
    h('p', null, `“${name}” is a Lunar Magic graphics package (sample level ${file(plan.mwl)}). Taken over into level ${lvl}: what is checked below, the graphics slots its tiles use and the colors per .palmask. Layer 1, sprites and header of level ${lvl} stay.`),
    plan.level.bg ? h('label', { class: 'row small' }, check(useBg, (v) => (useBg = v), !canBg),
      canBg ? ` Background: the BG tilemap${n16 ? ` and ${n16} BG Map16 tiles` : ''}` : ` Background – not possible: level ${lvl} has layer 2 objects instead of a BG background`) : '',
    plan.map16 && canBg ? h('div', { class: 'prop' }, h('label', { title: file(plan.map16.file) }, 'BG Map16'),
      h('span', null, `${n16} tiles from BG tile `), hexInput(at, 3, (v) => (at = v), 0xfff),
      h('span', { class: 'hint' }, at !== plan.map16.from ? ` (from ${hex(plan.map16.from, 3)} in the package, already in use there)` : '')) : '',
    plan.fg ? h('label', { class: 'row small' }, check(useFg, (v) => (useFg = v)), ` Foreground: ${plan.fg.data.tiles.length} FG Map16 tiles (${file(plan.fg.file)}) to place in levels`) : '',
    plan.fg ? h('div', { class: 'prop' }, h('label', null, 'FG Map16'),
      h('span', null, 'from tile '), hexInput(fgAt, 3, (v) => (fgAt = v), 0xfff),
      h('span', { class: 'hint' }, fgAt !== plan.fg.from ? ` (from ${hex(plan.fg.from, 3)} in the package, already in use there)` : '')) : '',
    ...plan.gfx.map((g) => g.file
      ? h('div', { class: 'prop' }, h('label', null, `${g.slot}: ${file(g.file)}`),
        h('span', null, 'as ExGFX '), hexInput(g.num, 2, (v) => (g.num = v), 0xfe),
        g.lmNum > 0xff ? h('span', { class: 'hint' }, ` (Lunar Magic: ${hex(g.lmNum, 3)})`) : '')
      : h('div', { class: 'prop' }, h('label', null, g.slot), h('span', { class: 'hint' }, `ROM graphics file ${hex(g.num, 2)}`))),
    ...plan.palettes.map((p, i) => h('label', { class: 'row small' }, check(usePal[i], (v) => (usePal[i] = v)),
      ` Colors from ${file(p.file)}: ${p.colors.length} color(s)${p.back ? ' and the background color' : ''} (custom palette for level ${lvl})`,
      p.layer3 ? h('span', { class: 'hint' }, ' – layer 3 colors') : '')),
    plan.layer3.length ? h('p', { class: 'hint' }, `Layer 3 (${plan.layer3.map(file).join(', ')}) is not taken over – Lunar Magic's layer 3 tilemaps are not supported yet.`) : '',
    ext && !extGfxAvailable(app.rom) ? h('p', { class: 'hint' }, 'For the BG2/BG3 slots the VRAM patch is installed.') : '',
    plan.notes.length ? h('ul', { class: 'hint' }, plan.notes.map((t) => h('li', null, t))) : '',
    log);
  modal(`Graphics: ${name}`, body, [
    { label: 'Cancel' },
    { label: 'Set up', primary: true, onClick: () => {
      let r: BgPackResult;
      try {
        r = app.romEdit(`Graphics “${name}” in level ${lvl}`, () => {
          const before = app.rom.snapshot();
          // BG2/BG3 need the tilemaps moved out of VRAM $2000 first
          if (ext && !extGfxAvailable(app.rom)) {
            const v = installVramPatch(app.rom);
            if (!v.ok) return { ok: false, errors: v.errors, notes: [], bg: null };
          }
          const res = applyBgPack(app.rom, app.level, files, plan, { bg: useBg, fg: useFg, at, fgAt, palettes: usePal, cgram: levelColors(app.render), blank });
          if (!res.ok) app.rom.restore(before);
          return res;
        });
      } catch (e) { r = { ok: false, errors: [errorText(e)], notes: [], bg: null }; }
      if (!r.ok) { resultLog(log, { ok: false, errors: r.errors, warnings: [], prints: [] }); return false; }
      app.checkpoint();
      if (r.bg) { app.level.bg = r.bg; app.changed(); }
      app.emit('level-header');
      app.emit('patch');
      toast(`Graphics “${name}” set up: ${r.notes.join(' · ')}${r.bg ? ' – level not saved yet' : ''}`);
      onDone();
      return true;
    } },
  ]);
}

// the tabs of the Packages dialog: the package list and the view of each tool
export type PackagesTab = 'packages' | ToolKind | 'music';
// what the tab the package is added from suggests: where UberASM code runs, the tile of a block
export interface AddPreset { uberContext: UberContext; tile: number }
export interface PickedUpload {
  name: string;
  target: PackagesTab | null; // the tab showing it afterwards; null: neither (a background goes into the level)
  affects: PackagesTab[]; // project tabs whose staged changes the dialog would bypass
  open(preset: AddPreset, done: () => void): void;
}

// picks an .asm/.zip and recognizes what it is; open() shows the dialog adding it. `manual`: always the
// dialog assigning the package's parts by hand
function isMusicUpload(files: Map<string, Uint8Array>): boolean {
  const paths = [...files.keys()];
  if (paths.some((p) => /\.(asm|asar)$/i.test(p))) return false;
  return paths.some((p) => /\.txt$/i.test(p) && isSongText(new TextDecoder().decode(files.get(p)!)));
}

export async function pickUpload(app: App, manual = false): Promise<PickedUpload | null> {
  const f = await pickFile('.asm,.asar,.zip,.txt');
  if (!f) return null;
  return recognize(app, f.name, uploadFiles(f.name, new Uint8Array(await f.arrayBuffer())), manual);
}

// what a package (its files, paths relative to its root) is, with the dialog adding it
// `into`: the installed package this is a part of; otherwise adding it makes a new one (see pkgtrack.ts)
export function recognize(app: App, fileName: string, files: Map<string, Uint8Array>, manual = false, into?: Tracker): PickedUpload {
  const base = fileName.replace(/\.[^.]*$/, '').split(/[\\/]/).pop()!;
  // what the dialog adds is kept as one package
  const tracked = (name: string, open: (p: AddPreset, done: () => void, t: Tracker) => void) => (p: AddPreset, done: () => void) => {
    const t = into ?? trackPackage(app, name, fileName, files);
    open(p, () => { t.done(); done(); }, t);
  };
  // UberASM Tool folders inside, next to folders they include (like Retry System): assigned by hand,
  // starting from the suggestion; its other parts are added afterwards like packages of their own
  const sug = suggestMapping(files);
  if (manual || sug && (sug.root !== '' || sug.extra.length)) {
    const rules = sug?.rules ?? new Map([['', null]]);
    return { name: base, target: 'uberasm', affects: TOOL_KINDS, open: tracked(base, (p, done, t) => openPkgMapDialog(app, base, files, rules, done,
      (name, part, partDone) => recognize(app, name, part, false, t).open(p, partDone))) };
  }
  // AddmusicK songs (MML .txt, BRR samples) and no ASM: music
  if (isMusicUpload(files)) return { name: base, target: 'music', affects: ['music'], open: tracked(base, (_, done) => openAddSongDialog(app, fileName, files, done)) };
  if (isLevelImport(files)) return { name: base, target: 'packages', affects: [], open: tracked(base, (_, done) => openBgPackDialog(app, fileName, files, done)) };
  const upload = uploadFromFiles(fileName, files);
  const info = detectKind(upload);
  switch (info.kind) {
    case 'uberasm': return { name: upload.name, target: 'uberasm', affects: ['uberasm'], open: tracked(upload.name, (p, done) => openUberResourceDialog(app, upload, info, p, done)) };
    case 'block': return info.pack
      ? { name: upload.name, target: 'block', affects: ['block'], open: tracked(upload.name, (_, done) => openBlockPackDialog(app, upload, info, done)) }
      : { name: upload.name, target: 'block', affects: ['block'], open: tracked(upload.name, (p, done) => openBlockResourceDialog(app, upload, info, p, done)) };
    case 'sprite': return { name: upload.name, target: 'sprite', affects: ['sprite', 'block'], open: tracked(upload.name, (_, done) => openPixiUploadDialog(app, upload, done)) };
    default: return { name: upload.name, target: 'packages', affects: [], open: tracked(upload.name, (_, done) => openApplyDialog(app, upload, fileName, null, done)) };
  }
}
