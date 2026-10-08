// Packages (see CONTEXT.md): uploading one is the only way third-party content enters the ROM. This
// module owns the lifecycle behind a small interface:
// - inspectUpload: file name and bytes in, an upload preview out – the detected parts (with the patch
//   options of a patch part), a package to assign by hand, a level import, or a failure saying what was
//   found and what is missing;
// - installPackage: applies every part of a previewed upload and records what it brought as one package
//   (observed like pkgreg.ts does: the ROM's projects before and after); all or nothing;
// - removePackage: the package and everything it brought, files shared with other packages kept;
// - wrapLegacyPatches: patches applied before packages were tracked become a legacy package each.

import { zipSync } from 'fflate';
import type { Rom } from './rom.ts';
import type { ApplyResult } from './patchapply.ts';
import { applyPatch } from './patchapply.ts';
import type { PartKind } from './parts.ts';
import { PART_LABEL } from './parts.ts';
import { uploadFiles, uploadFromFiles, detectKind, uploadSource, effectiveDefines, packUpload, type Upload } from './patchpkg.ts';
import { suggestMapping, withIncludes, type PkgSuggestion } from './pkgmap.ts';
import { isLevelImport } from './bgpack.ts';
import { isSongText, songsFromFiles, loadMusicProject, emptyMusicProject, addSongs, nextFreeSong, folders as musicFolders, saveMusicProject, hasAmk, musicEntry } from './music.ts';
import { pixiParts, planPixiUpload, applyPixiUpload } from './pixipkg.ts';
import { planBlockPack, applyBlockPack } from './blockpack.ts';
import { loadProject, saveProject, emptyProject, projectFromFiles, type UberProject } from './uberproject.ts';
import { loadBlockProject, saveBlockProject, type BlockProject } from './blocks.ts';
import { installEditorPatch, extGfxAvailable, setLevelMusic } from './patches.ts';
import { installVramPatch } from './vrampatch.ts';
import { installMap16Ext, map16Ext, setExtTileWords, EXT_FIRST, EXT_TILES } from './map16ext.ts';
import { ALL, type UberContext } from './uberasm.ts';
import { snapshot, partsBetween, mergeParts, emptyParts, isEmptyParts, savePackage, listPackages, uninstallPackageWithMusic, type Package } from './pkgreg.ts';
import { listPatches } from './patchreg.ts';

// one part as the preview lists it
export interface PreviewPart { kind: PartKind; name: string; file: string }

// the patch part: its upload, the main file (chosen among `candidates` when the upload doesn't say)
export interface PatchChoice { upload: Upload; main: string; candidates: string[] }

// how a part goes into the ROM
type Step =
  | { kind: 'patch' }
  | { kind: 'uberasm'; upload: Upload; file: string; ctx: UberContext }
  | { kind: 'uber-folder'; project: UberProject }
  | { kind: 'block'; upload: Upload; file: string; acts?: number }
  | { kind: 'blockpack'; upload: Upload; list: string }
  | { kind: 'pixi'; upload: Upload }
  | { kind: 'music' };

interface PreviewBase { name: string; fileName: string; files: Map<string, Uint8Array> }
export interface ReadyPreview extends PreviewBase { status: 'ready'; parts: PreviewPart[]; patch: PatchChoice | null; steps: Step[] }
export type UploadPreview =
  | ReadyPreview
  | PreviewBase & { status: 'manual'; suggestion: PkgSuggestion } // tool folders next to folders they include (Retry System)
  | PreviewBase & { status: 'level-import' } // a Lunar Magic level (.mwl): not a package
  | PreviewBase & { status: 'failed'; reason: string };

const dec = new TextDecoder();
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const nameOf = (fileName: string) => fileName.replace(/\.[^.]*$/, '').split(/[\\/]/).pop()!;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : one.endsWith('h') ? 'es' : 's'}`;

// "2 sprites, 1 UberASM file, 1 song"
const COUNT_NOUN: Record<PartKind, string> = { patch: 'patch', uberasm: 'UberASM file', block: 'block', sprite: 'sprite', music: 'song', graphics: 'graphics file' };
export function partsSummary(parts: PreviewPart[]): string {
  const n = new Map<PartKind, number>();
  for (const p of parts) n.set(p.kind, (n.get(p.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => plural(c, COUNT_NOUN[k])).join(', ');
}
export const partLabel = (k: PartKind) => PART_LABEL[k];

export function inspectUpload(fileName: string, data: Uint8Array): UploadPreview {
  const name = nameOf(fileName);
  let files: Map<string, Uint8Array>;
  try { files = uploadFiles(fileName, data); } catch (e) {
    return { status: 'failed', name, fileName, files: new Map(), reason: e instanceof Error ? e.message : String(e) };
  }
  return inspectFiles(fileName, files);
}

// what a package (its files, paths relative to its root) is
export function inspectFiles(fileName: string, files: Map<string, Uint8Array>): UploadPreview {
  const name = nameOf(fileName);
  const head = { name, fileName, files };
  if (!files.size) return { ...head, status: 'failed', reason: 'The upload is empty.' };
  if (isLevelImport(files)) return { ...head, status: 'level-import' };
  // UberASM Tool folders whose code includes folders next to them: placed by hand (from the suggestion)
  const sug = suggestMapping(files);
  if (sug?.extra.length) return { ...head, status: 'manual', suggestion: sug };

  const parts: PreviewPart[] = [];
  const steps: Step[] = [];
  const paths = [...files.keys()];
  const asm = paths.filter((p) => /\.(asm|asar)$/i.test(p));
  const songs = paths.filter((p) => /\.txt$/i.test(p) && isSongText(dec.decode(files.get(p)!)));
  if (songs.length) {
    steps.push({ kind: 'music' });
    for (const p of songs) parts.push({ kind: 'music', name: base(p).replace(/\.txt$/i, ''), file: p });
  }
  if (!asm.length) {
    if (songs.length) return { ...head, status: 'ready', parts, patch: null, steps };
    return { ...head, status: 'failed', reason: `Found ${describe(paths)}, but no .asm file (patch, UberASM code, block or sprite), no AddmusicK song (.txt) and no Lunar Magic level (.mwl).` };
  }
  let upload: Upload;
  try { upload = uploadFromFiles(fileName, files); } catch (e) {
    return { ...head, status: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
  // a patch with a manifest is one patch, whatever else it holds
  if (upload.manifest) {
    const main = upload.manifest.main;
    return { ...head, name: upload.name, status: 'ready', parts: [{ kind: 'patch', name: upload.name, file: main }], patch: { upload, main, candidates: [main] }, steps: [{ kind: 'patch' }] };
  }

  const claimed = new Set<string>();
  // an UberASM Tool folder: its list.txt has the sections of UberASM Tool
  const list = paths.find((p) => /^([^/]+\/)?list\.txt$/i.test(p));
  if (list && /^\s*(level|gamemode|overworld)\s*:/im.test(dec.decode(files.get(list)!))) {
    try {
      const project = projectFromFiles(files);
      steps.push({ kind: 'uber-folder', project });
      for (const f of [...project.files.keys()].filter((f) => /^(level|gamemode|overworld)\/[^/]+\.asm$/i.test(f)).sort()) parts.push({ kind: 'uberasm', name: base(f), file: f });
      for (const p of paths) claimed.add(p);
    } catch { /* not a tool folder after all */ }
  }
  // sprites (PIXI; a PIXI folder too) with the blocks they bring
  const pixi = claimed.size ? null : pixiParts(upload);
  if (pixi && pixi.sprites.length) {
    steps.push({ kind: 'pixi', upload });
    for (const s of pixi.sprites) parts.push({ kind: 'sprite', name: s.name, file: s.file });
    for (const b of pixi.blocks) parts.push({ kind: 'block', name: base(b.file), file: b.file });
    for (const f of [...pixi.sprites.map((s) => s.file), ...pixi.blocks.map((b) => b.file)]) {
      const dir = f.slice(0, f.lastIndexOf('/') + 1);
      for (const p of paths) if (p.startsWith(dir) && (dir || p === f)) claimed.add(p);
    }
    for (const r of pixi.routines) claimed.add(r);
    for (const p of asm) if (!/\.(json|cfg)$/i.test(p) && /print\s+"(INIT|MAIN) ?"\s*,\s*pc/i.test(dec.decode(files.get(p)!))) claimed.add(p);
  }
  // a block package or GPS folder: list.txt with the blocks (often a .map16 file and ExGFX)
  const blockList = claimed.size ? undefined : paths.find((p) => /(^|\/)list\.txt$/i.test(p) && /^[0-9a-f]{3,4}(:[0-9a-f]{3})?\s+\S+\.asm/im.test(dec.decode(files.get(p)!)));
  if (blockList) {
    const plan = planBlockPack(upload, blockList);
    if (plan.blocks.length) {
      steps.push({ kind: 'blockpack', upload, list: blockList });
      for (const b of plan.blocks) parts.push({ kind: 'block', name: base(b.file), file: b.file });
      for (const g of plan.gfx) parts.push({ kind: 'graphics', name: base(g.file), file: g.file });
      for (const f of [blockList, ...plan.blocks.map((b) => b.file), ...plan.gfx.map((g) => g.file), ...(plan.map16 ? [plan.map16.file] : [])]) claimed.add(f);
    }
  }
  // the other .asm files that nothing includes: UberASM code, blocks, a patch. Shared code (library/,
  // routines/, other/) goes with the part using it.
  const included = new Set<string>();
  for (const p of asm) for (const f of withIncludes(files, new Map([[p, files.get(p)!]])).keys()) if (f !== p) included.add(f);
  const candidates: string[] = [];
  for (const p of upload.asmFiles) {
    if (claimed.has(p) || included.has(p) || /(^|\/)(library|routines|other)\//i.test(p)) continue;
    const ctx = /(^|\/)(level|gamemode|overworld)\/[^/]+$/i.exec(p)?.[2].toLowerCase() as UberContext | undefined;
    const kind = ctx ? null : detectKind(upload, p);
    if (ctx || kind?.kind === 'uberasm') {
      steps.push({ kind: 'uberasm', upload, file: p, ctx: ctx ?? 'level' });
      parts.push({ kind: 'uberasm', name: base(p), file: p });
    } else if (kind?.kind === 'block') {
      steps.push({ kind: 'block', upload, file: p, acts: kind.acts });
      parts.push({ kind: 'block', name: base(p), file: p });
    } else candidates.push(p);
  }
  // one patch at most: the main file of the upload, or – when it has no other parts – one to choose
  let patch: PatchChoice | null = null;
  const main = upload.main && candidates.includes(upload.main) ? upload.main : candidates.length === 1 ? candidates[0] : null;
  if (main || (candidates.length && !parts.length)) {
    patch = { upload, main: main ?? candidates[0], candidates: main ? [main] : candidates };
    steps.unshift({ kind: 'patch' });
    parts.unshift({ kind: 'patch', name: upload.name, file: patch.main });
  }
  if (!parts.length) return { ...head, status: 'failed', reason: `Found ${describe(paths)}, but nothing to install: the .asm files are only included by each other.` };
  return { ...head, status: 'ready', parts, patch, steps };
}

// "3 files (2 .txt, 1 .png)"
function describe(paths: string[]): string {
  const ext = new Map<string, number>();
  for (const p of paths) { const e = /\.[^./]+$/.exec(p)?.[0].toLowerCase() ?? 'without extension'; ext.set(e, (ext.get(e) ?? 0) + 1); }
  return `${plural(paths.length, 'file')} (${[...ext].map(([e, n]) => `${n} ${e}`).join(', ')})`;
}

// ---------- installing ----------

export interface InstallOptions {
  level: number | null; // the current level: UberASM level code runs there, songs play there, a block package's graphics load there
  blank: number[]; // tile words of an empty Map16 tile
  tileWords(tile: number): number[]; // the words of a Map16 tile, for the graphics of new block tiles (from their acts like)
  patch?: { main?: string; values?: Record<string, string> }; // the patch part's main file and settings
}
export interface InstallResult extends ApplyResult { pkg: Package | null }

const failed = (errors: string[], warnings: string[] = []): InstallResult => ({ ok: false, errors, warnings, prints: [], pkg: null });

// built-in editor patches a patch.json asks for
export function ensureRequirements(rom: Rom, upload: Upload, blank: number[]): void {
  for (const req of upload.manifest?.requires ?? []) {
    if (req === 'smwe') installEditorPatch(rom);
    else if (req === 'smwx') { if (!map16Ext(rom)) installMap16Ext(rom, blank); }
    else throw new Error(`Unknown requirement “${req}” in patch.json`);
  }
}

// where a file of an upload goes in a tool folder: shared folders (wherever they are in the upload) to
// the top, the contents of a level/gamemode/overworld folder and other files into `folder`
function placeOf(f: string, folder: string): string {
  const shared = /(^|\/)(routines|library|other)\/(.*)$/i.exec(f);
  if (shared) return `${shared[2].toLowerCase()}/${shared[3]}`;
  return folder + (/(^|\/)(?:level|gamemode|overworld)\/(.*)$/i.exec(f)?.[2] ?? f);
}

// the files of one part for a tool folder: its main file (as `mainText`) and the .asm/.bin files that
// aren't other parts of the package
function placeFiles(preview: ReadyPreview, upload: Upload, main: string, mainText: string, folder: string): Map<string, Uint8Array> {
  const others = new Set(preview.parts.map((p) => p.file).filter((f) => f !== main));
  const out = new Map<string, Uint8Array>();
  for (const [f, c] of upload.files) {
    if (!/\.(asm|bin)$/i.test(f) || others.has(f)) continue;
    out.set(placeOf(f, folder), f === main ? new TextEncoder().encode(mainText) : c);
  }
  return out;
}

// applies every part and records the package; on failure the ROM is as before
export async function installPackage(rom: Rom, preview: ReadyPreview, opt: InstallOptions): Promise<InstallResult> {
  const before = rom.snapshot();
  const was = snapshot(rom);
  const warnings: string[] = [];
  const prints: string[] = [];
  const brought: Brought = { uber: new Set(), blocks: new Set() };
  try {
    for (const step of preview.steps) {
      const r = await installStep(rom, preview, step, opt, brought);
      warnings.push(...r.warnings);
      prints.push(...r.prints);
      if (!r.ok) { rom.restore(before); return failed(r.errors, r.warnings); }
    }
    const now = snapshot(rom);
    const parts = partsBetween(was, now);
    // files the package placed that were there already (same content, brought by another package too)
    // belong to it as well, so removing the other one keeps them
    for (const f of brought.uber) if (!parts.uber.files.includes(f)) parts.uber.files.push(f);
    for (const f of brought.blocks) if (!parts.blocks.files.includes(f)) parts.blocks.files.push(f);
    if (isEmptyParts(parts)) { rom.restore(before); return failed(['Nothing changed – everything in the package is already in the ROM.']); }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const rec: Package = { id, name: preview.name, fileName: preview.fileName, added: new Date().toISOString(), ...emptyParts() };
    const pkg = savePackage(rom, mergeParts(rec, parts, now), zipSync(Object.fromEntries(preview.files), { level: 9 }));
    return { ok: true, errors: [], warnings, prints, pkg };
  } catch (e) {
    rom.restore(before);
    return failed([e instanceof Error ? e.message : String(e)], warnings);
  }
}

// the project files the parts placed (tool → paths)
interface Brought { uber: Set<string>; blocks: Set<string> }

async function installStep(rom: Rom, preview: ReadyPreview, step: Step, opt: InstallOptions, brought: Brought): Promise<ApplyResult> {
  const ok: ApplyResult = { ok: true, errors: [], warnings: [], prints: [] };
  switch (step.kind) {
    case 'patch': {
      const { upload } = preview.patch!;
      const main = opt.patch?.main ?? preview.patch!.main;
      const values = opt.patch?.values ?? {};
      const src = uploadSource(upload, main, effectiveDefines(upload, values));
      src.settings = values;
      src.archive = packUpload({ fileName: preview.fileName, files: [...upload.files], main }); // kept with the editor data, to reapply it
      ensureRequirements(rom, upload, opt.blank);
      return applyPatch(rom, src);
    }
    case 'uberasm': {
      const folder = `${step.ctx}/`;
      const text = uploadSource(step.upload, step.file, {}).files.get(step.file) as string;
      const proj = loadProject(rom) ?? emptyProject();
      for (const [f, c] of placeFiles(preview, step.upload, step.file, text, folder)) { proj.files.set(f, c); brought.uber.add(f); }
      const file = placeOf(step.file, folder);
      const key = step.ctx === 'level' ? opt.level ?? ALL : step.ctx === 'gamemode' ? 0x14 : 0;
      const calls = proj.list[step.ctx].get(key) ?? [];
      if (!calls.some((c) => c.file === file)) calls.push({ file, bytes: [] });
      proj.list[step.ctx].set(key, calls);
      return saveProject(rom, proj);
    }
    case 'uber-folder': {
      const proj = loadProject(rom) ?? emptyProject();
      for (const [f, c] of step.project.files) if (f !== 'list.txt') { proj.files.set(f, c); brought.uber.add(f); }
      for (const ctx of ['level', 'gamemode', 'overworld'] as UberContext[]) {
        for (const [num, cs] of step.project.list[ctx]) {
          const have = proj.list[ctx].get(num) ?? [];
          proj.list[ctx].set(num, [...have, ...cs.filter((c) => !have.some((h) => h.file === c.file))]);
        }
      }
      for (const k of ['global', 'statusbar', 'macrolib'] as const) proj.list[k] ??= step.project.list[k];
      return saveProject(rom, proj);
    }
    case 'block': {
      const proj: BlockProject = loadBlockProject(rom) ?? { files: new Map(), list: [] };
      const used = new Set(proj.list.map((b) => b.tile));
      let tile = EXT_FIRST;
      while (used.has(tile) && tile < EXT_TILES - 1) tile++;
      const acts = step.acts ?? 0x130;
      const text = uploadSource(step.upload, step.file, {}).files.get(step.file) as string;
      for (const [f, c] of placeFiles(preview, step.upload, step.file, text, 'blocks/')) { proj.files.set(f, c); brought.blocks.add(f); }
      proj.list.push({ tile, file: placeOf(step.file, 'blocks/'), acts });
      const r = saveBlockProject(rom, proj, opt.blank);
      if (r.ok && tile >= EXT_FIRST) setExtTileWords(rom, tile, opt.tileWords(acts), opt.blank);
      return r;
    }
    case 'blockpack': {
      const plan = planBlockPack(step.upload, step.list);
      let level = opt.level;
      const warnings: string[] = [];
      // BG2/BG3 need the tilemaps moved out of VRAM $2000 first; without, the graphics are not loaded in the level
      if (level !== null && plan.gfx.some((g) => g.slot === 'BG2' || g.slot === 'BG3') && !extGfxAvailable(rom)) {
        const v = installVramPatch(rom);
        if (!v.ok) { level = null; warnings.push(`Graphics not loaded in the level (${v.errors.join(' ')}); use the level header's graphics bypass.`); }
      }
      const r = applyBlockPack(rom, step.upload, plan, { blank: opt.blank, level });
      return { ...r, warnings: [...warnings, ...r.warnings], prints: [...r.prints, ...r.notes] };
    }
    case 'pixi':
      return applyPixiUpload(rom, step.upload, planPixiUpload(rom, step.upload), opt.blank, opt.tileWords);
    case 'music': {
      if (hasAmk(rom) && !musicEntry(rom)) return { ...ok, ok: false, errors: ['AddmusicK was inserted by another tool – songs cannot be added here.'] };
      const proj = loadMusicProject(rom) ?? emptyMusicProject();
      const sf = songsFromFiles(preview.fileName, preview.files, musicFolders(proj));
      const num = nextFreeSong(proj);
      if (num < 0) return { ...ok, ok: false, errors: ['All song numbers up to FF are used.'] };
      const added = addSongs(proj, sf, num);
      const r = await saveMusicProject(rom, proj);
      if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, prints: [] };
      if (opt.level !== null) setLevelMusic(rom, opt.level, added[0].num);
      return { ...ok, warnings: [...r.warnings, ...sf.missing.map((m) => `Missing sample: ${m}`)] };
    }
  }
}

// ---------- removing ----------

// the package and everything it brought (songs too); files another package brought as well stay
export function removePackage(rom: Rom, id: string, blank: number[]): Promise<string[]> {
  return uninstallPackageWithMusic(rom, id, blank);
}

// ---------- legacy packages ----------

// every patch no package owns gets a legacy package of its own (when a ROM is opened); running it again
// changes nothing. Tool projects and editor patches (kind set) are not packages. Returns the new ones.
export function wrapLegacyPatches(rom: Rom): Package[] {
  const owned = new Set(listPackages(rom).flatMap((r) => r.patches));
  const out: Package[] = [];
  for (const p of listPatches(rom)) {
    if ((p.kind && p.kind !== 'patch') || owned.has(p.id)) continue;
    out.push(savePackage(rom, { id: `legacy-${p.id}`, name: p.name, fileName: p.name, added: p.applied, legacy: true, ...emptyParts(), patches: [p.id] }));
  }
  return out;
}
