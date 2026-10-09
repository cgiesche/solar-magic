// Packages (see CONTEXT.md): uploading one is the only way third-party content enters the ROM. This
// module owns the lifecycle behind a small interface:
// - inspectUpload: file name and bytes in, an upload preview out – the detected parts (with the patch
//   options of a patch part), a package to assign by hand, a level import, or a failure saying what was
//   found and what is missing;
// - installPackage: applies every part of a previewed upload and records what it brought as one package
//   (observed like pkgreg.ts does: the ROM's projects before and after); all or nothing;
// - removePackage: the package and everything it brought, files shared with other packages kept;
// - wrapLegacyPatches: patches applied before packages were tracked become a legacy package each.

import { zipSync, unzipSync } from 'fflate';
import type { Rom } from './rom.ts';
import type { ApplyResult } from './patchapply.ts';
import { applyPatch } from './patchapply.ts';
import type { PartKind } from './parts.ts';
import { PART_LABEL } from './parts.ts';
import { uploadFiles, uploadFromFiles, uploadSource, effectiveDefines, packUpload, type Upload } from './patchpkg.ts';
import { suggestMapping, placed, suggestCalls, packageDocs, type PkgSuggestion, type PkgRules } from './pkgmap.ts';
import { isSongText, songsFromFiles, loadMusicProject, emptyMusicProject, addSongs, nextFreeSong, folders as musicFolders, saveMusicProject, hasAmk, musicEntry } from './music.ts';
import { pixiParts, planPixiUpload, applyPixiUpload, linkedDefines, type PixiPlan } from './pixipkg.ts';
import { parseCfg, parseJsonCfg } from './pixi.ts';
import { detectBlocks, detectGraphics, graphicsFiles, includedFiles, planPackage, applyBlocks, applyGraphics, applyLevelSetup, routinesCalled, type DetectedBlock, type DetectedGraphics, type PackagePlan } from './pkgplan.ts';
import { loadProject, saveProject, emptyProject, projectFromFiles, type UberProject } from './uberproject.ts';
import { installEditorPatch, extGfxAvailable, setLevelMusic } from './patches.ts';
import { map16Targets } from './map16file.ts';
import { installVramPatch } from './vrampatch.ts';
import { installMap16Ext, map16Ext } from './map16ext.ts';
import { ALL, type UberContext } from './uberasm.ts';
import { recordPackageChangeAsync, emptyParts, savePackage, listPackages, packageArchive, uninstallPackage, type Package, type Claim } from './pkgreg.ts';
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
  | { kind: 'pixi'; upload: Upload }
  | { kind: 'blocks'; upload: Upload }
  | { kind: 'graphics' }
  | { kind: 'music' }
  | { kind: 'mapped'; assignment: ManualAssignment };

interface PreviewBase { name: string; fileName: string; files: Map<string, Uint8Array> }
export interface ReadyPreview extends PreviewBase {
  status: 'ready';
  parts: PreviewPart[];
  patch: PatchChoice | null;
  steps: Step[];
  blocks: DetectedBlock[]; // the block parts (tiles from list.txt)
  graphics: DetectedGraphics; // the graphics parts and the sample level
  sprites: string[]; // the sprite parts' files
  unclaimed: string[]; // files no part takes: not installed
  docs: string[]; // the package's manuals (readme)
}
// tool folders next to folders they include (Retry System): assigned by hand, starting from the suggestion
export interface ManualPreview extends PreviewBase { status: 'manual'; suggestion: PkgSuggestion }
export type UploadPreview =
  | ReadyPreview
  | ManualPreview
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

// what a package (its files, paths relative to its root) is: each file belongs to one part, decided by
// the file alone (ADR 0002)
export function inspectFiles(fileName: string, files: Map<string, Uint8Array>): UploadPreview {
  const name = nameOf(fileName);
  const head = { name, fileName, files };
  if (!files.size) return { ...head, status: 'failed', reason: 'The upload is empty.' };
  const paths = [...files.keys()];
  const asm = paths.filter((p) => /\.(asm|asar)$/i.test(p));
  const songs = paths.filter((p) => /\.txt$/i.test(p) && isSongText(dec.decode(files.get(p)!)));
  const included = includedFiles(files);
  const graphics = detectGraphics(files, included);
  // a Lunar Magic level without code or songs: a level import, not a package
  if (graphics.mwl && !asm.length && !songs.length) return { ...head, status: 'level-import' };
  // UberASM Tool folders whose code includes folders next to them: placed by hand (from the suggestion)
  const sug = asm.length ? suggestMapping(files) : null;
  if (sug?.extra.length) return { ...head, status: 'manual', suggestion: sug };

  const parts: PreviewPart[] = [];
  const steps: Step[] = [];
  const claimed = new Set<string>();
  const docs = packageDocs(files);
  let upload: Upload | null = null;
  if (asm.length) {
    try { upload = uploadFromFiles(fileName, files); } catch (e) {
      return { ...head, status: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
    // a patch with a manifest is one patch, whatever else it holds
    if (upload.manifest) {
      const main = upload.manifest.main;
      return { ...head, name: upload.name, status: 'ready', parts: [{ kind: 'patch', name: upload.name, file: main }], patch: { upload, main, candidates: [main] }, steps: [{ kind: 'patch' }], blocks: [], graphics: noGraphics(), sprites: [], unclaimed: [], docs };
    }
  }
  if (songs.length) {
    steps.push({ kind: 'music' });
    for (const p of songs) { parts.push({ kind: 'music', name: base(p).replace(/\.txt$/i, ''), file: p }); claimed.add(p); }
  }
  const gfxFiles = graphicsFiles(graphics);
  const sprites: string[] = [];
  let blocks: DetectedBlock[] = [];
  const candidates: string[] = [];
  if (upload) {
    // an UberASM Tool folder: its list.txt has the sections of UberASM Tool
    const list = paths.find((p) => /^([^/]+\/)?list\.txt$/i.test(p));
    if (list && /^\s*(level|gamemode|overworld)\s*:/im.test(dec.decode(files.get(list)!))) {
      try {
        const project = projectFromFiles(files);
        steps.push({ kind: 'uber-folder', project });
        for (const f of [...project.files.keys()].filter((f) => /^(level|gamemode|overworld)\/[^/]+\.asm$/i.test(f)).sort()) parts.push({ kind: 'uberasm', name: base(f), file: f });
        const root = list.slice(0, list.length - 'list.txt'.length);
        for (const p of paths) if (p.startsWith(root) && !gfxFiles.includes(p)) claimed.add(p);
      } catch { /* not a tool folder after all */ }
    }
    // blocks: named in a GPS list.txt or found by their content
    const found = detectBlocks(files, claimed);
    blocks = found.blocks;
    if (found.list) claimed.add(found.list);
    // sprites (PIXI): cfg/json with their .asm, misc sprites by their folder
    const pixi = pixiParts(upload);
    for (const s of pixi.sprites) {
      if (claimed.has(s.file) || blocks.some((b) => b.file === s.file)) continue;
      sprites.push(s.file);
      parts.push({ kind: 'sprite', name: s.name, file: s.file });
      claimed.add(s.file);
      // its folder (cfg/json next to it, files it includes) – not what belongs to other parts
      const dir = s.file.slice(0, s.file.lastIndexOf('/') + 1);
      if (dir) for (const p of paths) if (p.startsWith(dir) && !gfxFiles.includes(p) && !blocks.some((b) => b.file === p) && !docs.includes(p)) claimed.add(p);
      const cfg = /\.(json|cfg)$/i.test(s.file) ? cfgAsm(upload, s.file) : null;
      if (cfg) claimed.add(cfg);
    }
    if (sprites.length) steps.push({ kind: 'pixi', upload });
    for (const b of blocks) {
      claimed.add(b.file);
      if (!parts.some((p) => p.kind === 'block' && p.file === b.file)) parts.push({ kind: 'block', name: base(b.file), file: b.file });
    }
    if (blocks.length) steps.push({ kind: 'blocks', upload });
    // the other .asm files that nothing includes: UberASM code or a patch. Shared code (library/,
    // routines/, other/) goes with the part using it.
    for (const p of upload.asmFiles) {
      if (claimed.has(p) || included.has(p) || /(^|\/)(library|routines|other)\//i.test(p)) continue;
      claimed.add(p);
      const ctx = /(^|\/)(level|gamemode|overworld)\/[^/]+$/i.exec(p)?.[2].toLowerCase() as UberContext | undefined;
      if (ctx || isUberText(dec.decode(files.get(p)!))) {
        steps.push({ kind: 'uberasm', upload, file: p, ctx: ctx ?? 'level' });
        parts.push({ kind: 'uberasm', name: base(p), file: p });
      } else candidates.push(p);
    }
  }
  // graphics parts
  for (const f of gfxFiles) { parts.push({ kind: 'graphics', name: base(f), file: f }); claimed.add(f); }
  if (gfxFiles.length) steps.push({ kind: 'graphics' });
  // one patch at most: the main file of the upload, or – when it has no other parts – one to choose
  let patch: PatchChoice | null = null;
  const main = upload?.main && candidates.includes(upload.main) ? upload.main : candidates.length === 1 ? candidates[0] : null;
  if (upload && (main || (candidates.length && !parts.length))) {
    patch = { upload, main: main ?? candidates[0], candidates: main ? [main] : candidates };
    steps.unshift({ kind: 'patch' });
    parts.unshift({ kind: 'patch', name: upload.name, file: patch.main });
  }
  for (const c of candidates) if (c !== patch?.main && !patch?.candidates.includes(c)) claimed.delete(c);
  if (graphics.mwl) claimed.add(graphics.mwl);
  if (!parts.length) {
    if (!asm.length) return { ...head, status: 'failed', reason: `Found ${describe(paths)}, but no .asm file (patch, UberASM code, block or sprite), no AddmusicK song (.txt), no graphics and no Lunar Magic level (.mwl).` };
    return { ...head, status: 'failed', reason: `Found ${describe(paths)}, but nothing to install: the .asm files are only included by each other.` };
  }
  // shared code goes with the parts using it; what is left is not installed
  const unclaimed = paths.filter((p) => !claimed.has(p) && !included.has(p) && !(upload && /(^|\/)(library|routines|other)\/.*\.(asm|asar)$/i.test(p))).sort();
  return { ...head, status: 'ready', parts, patch, steps, blocks, graphics, sprites, unclaimed, docs };
}

const noGraphics = (): DetectedGraphics => ({ map16: [], exgfx: [], pal: [], palmask: [], mwl: null });

// the .asm a sprite's cfg/json names
function cfgAsm(upload: Upload, cfg: string): string | null {
  try {
    const t = dec.decode(upload.files.get(cfg)!);
    const c = /\.json$/i.test(cfg) ? parseJsonCfg(t, cfg) : parseCfg(t, cfg);
    return c.asm && upload.files.has(c.asm) ? c.asm : null;
  } catch { return null; }
}

// UberASM code: entry labels and no hijack/free space of its own
function isUberText(src: string): boolean {
  const st = src.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
  return st.some((l) => /^(init|main|load|end|nmi)\s*:/i.test(l)) && !st.some((l) => /^(org|freecode|freedata|autoclean|pushpc|lorom|sa1rom|hirom)\b/i.test(l));
}

// "3 files (2 .txt, 1 .png)"
function describe(paths: string[]): string {
  const ext = new Map<string, number>();
  for (const p of paths) { const e = /\.[^./]+$/.exec(p)?.[0].toLowerCase() ?? 'without extension'; ext.set(e, (ext.get(e) ?? 0) + 1); }
  return `${plural(paths.length, 'file')} (${[...ext].map(([e, n]) => `${n} ${e}`).join(', ')})`;
}

// ---------- installing ----------

// what goes where for a package assigned by hand: package node → UberASM project folder (null: left
// out), and the list.txt lines of its resource files
export interface ManualAssignment { rules: PkgRules; calls: { file: string; ctx: UberContext; num: number }[] }

// the suggestion: its folders, and a list.txt line for each resource file (number from the docs, else
// `level` for level code, game mode 14, overworld map 0)
export function defaultAssignment(p: ManualPreview, level: number): ManualAssignment {
  const rules: PkgRules = new Map(p.suggestion.rules);
  const calls = suggestCalls(p.files, placed(p.files.keys(), rules), { level, gamemode: 0x14, overworld: 0 }).map(({ file, ctx, num }) => ({ file, ctx, num }));
  return { rules, calls };
}

export interface InstallOptions {
  level: number | null; // the current level: UberASM level code runs there, songs play there, a block package's graphics load there
  blank: number[]; // tile words of an empty Map16 tile
  tileWords(tile: number): number[]; // the words of a Map16 tile, for the graphics of new block tiles (from their acts like)
  patch?: { main?: string; values?: Record<string, string> }; // the patch part's main file and settings
  assignment?: ManualAssignment; // a package assigned by hand (default: the suggestion)
  plan?: PackagePlan; // where blocks, Map16 tiles and ExGFX go, with their links (default: planUpload's)
  setup?: boolean; // the level setup for `level`: the package's ExGFX in its slots, its colors (default: on)
  cgram?: Uint8Array; // the colors of `level` now (levelColors), base of its own palette for the setup
}
export interface InstallResult extends ApplyResult { pkg: Package | null }

// where the package's blocks, Map16 tiles and ExGFX would go in this ROM, and how they link up
export function planUpload(rom: Rom, preview: ReadyPreview, blank: number[]): PackagePlan {
  return planPackage(rom, { files: preview.files, blocks: preview.blocks, graphics: preview.graphics }, blank);
}

// what the steps share: the plan, the sprites' numbers
interface InstallContext { plan: PackagePlan; pixi: PixiPlan | null }

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
export async function installPackage(rom: Rom, preview: ReadyPreview | ManualPreview, opt: InstallOptions): Promise<InstallResult> {
  if (preview.status === 'manual') {
    const a = opt.assignment ?? defaultAssignment(preview, opt.level ?? 0x105);
    const ready: ReadyPreview = { ...preview, status: 'ready', parts: [], patch: null, steps: [{ kind: 'mapped', assignment: a }], blocks: [], graphics: { map16: [], exgfx: [], pal: [], palmask: [], mwl: null }, sprites: [], unclaimed: [], docs: [] };
    return installPackage(rom, ready, opt);
  }
  const before = rom.snapshot();
  const warnings: string[] = [];
  const prints: string[] = [];
  try {
    const upload = preview.steps.find((s): s is Extract<Step, { upload: Upload }> => 'upload' in s)?.upload;
    const ctx: InstallContext = {
      plan: opt.plan ?? planUpload(rom, preview, opt.blank),
      pixi: preview.sprites.length && upload ? planPixiUpload(rom, upload) : null,
    };
    if (ctx.pixi) ctx.pixi.sprites = ctx.pixi.sprites.filter((s) => preview.sprites.includes(s.file));
    const archive = zipSync(Object.fromEntries(preview.files), { level: 9 });
    const { result, pkg } = await recordPackageChangeAsync(rom, { name: preview.name, fileName: preview.fileName, archive }, async (claim) => {
      for (const step of preview.steps) {
        const r = await installStep(rom, preview, step, opt, ctx, claim);
        warnings.push(...r.warnings);
        prints.push(...r.prints);
        if (!r.ok) return r;
      }
      if (opt.level !== null && opt.setup !== false && (ctx.plan.gfx.some((g) => g.slot) || ctx.plan.palettes.length)) {
        const r = levelSetup(rom, opt.level, ctx.plan, opt.cgram ?? null);
        warnings.push(...r.warnings);
        prints.push(...r.prints);
      }
      const done: ApplyResult = { ok: true, errors: [], warnings: [], prints: [] };
      return done;
    });
    if (!result.ok) return failed(result.errors, result.warnings);
    if (!pkg) { rom.restore(before); return failed(['Nothing changed – everything in the package is already in the ROM.']); }
    return { ok: true, errors: [], warnings, prints, pkg };
  } catch (e) {
    return failed([e instanceof Error ? e.message : String(e)], warnings);
  }
}

// the level setup; BG2/BG3 need the tilemaps moved out of VRAM $2000 first (the VRAM patch)
function levelSetup(rom: Rom, level: number, plan: PackagePlan, cgram: Uint8Array | null): { warnings: string[]; prints: string[] } {
  const warnings: string[] = [];
  if (plan.gfx.some((g) => g.slot === 'BG2' || g.slot === 'BG3') && !extGfxAvailable(rom)) {
    const v = installVramPatch(rom);
    if (!v.ok) warnings.push(`BG2/BG3 graphics not loaded in the level (${v.errors.join(' ')}); use the level header's graphics bypass.`);
  }
  const r = applyLevelSetup(rom, level, plan, cgram);
  return { warnings: [...warnings, ...r.warnings], prints: r.prints };
}

async function installStep(rom: Rom, preview: ReadyPreview, step: Step, opt: InstallOptions, ctx: InstallContext, claim: Claim): Promise<ApplyResult> {
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
      for (const [f, c] of placeFiles(preview, step.upload, step.file, text, folder)) { proj.files.set(f, c); claim('uber', f); }
      const file = placeOf(step.file, folder);
      const key = step.ctx === 'level' ? opt.level ?? ALL : step.ctx === 'gamemode' ? 0x14 : 0;
      const calls = proj.list[step.ctx].get(key) ?? [];
      if (!calls.some((c) => c.file === file)) calls.push({ file, bytes: [] });
      proj.list[step.ctx].set(key, calls);
      return saveProject(rom, proj);
    }
    case 'uber-folder': {
      const proj = loadProject(rom) ?? emptyProject();
      for (const [f, c] of step.project.files) if (f !== 'list.txt') { proj.files.set(f, c); claim('uber', f); }
      for (const ctx of ['level', 'gamemode', 'overworld'] as UberContext[]) {
        for (const [num, cs] of step.project.list[ctx]) {
          const have = proj.list[ctx].get(num) ?? [];
          proj.list[ctx].set(num, [...have, ...cs.filter((c) => !have.some((h) => h.file === c.file))]);
        }
      }
      for (const k of ['global', 'statusbar', 'macrolib'] as const) proj.list[k] ??= step.project.list[k];
      return saveProject(rom, proj);
    }
    case 'pixi': {
      const others = new Set(preview.parts.filter((p) => p.kind !== 'sprite').map((p) => p.file));
      const plan = { ...ctx.pixi!, routines: partRoutines(preview, step.upload, 'sprite') };
      return applyPixiUpload(rom, step.upload, plan, others);
    }
    case 'blocks': {
      const defines = ctx.pixi ? linkedDefines(ctx.pixi) : new Map<string, Record<string, string>>();
      const drawn = new Set(ctx.plan.map16 ? map16Targets(ctx.plan.map16.data, ctx.plan.map16.at) : []);
      return applyBlocks(rom, step.upload, ctx.plan.blocks, defines, partRoutines(preview, step.upload, 'block'), opt.blank, opt.tileWords, drawn, (f) => claim('blocks', f));
    }
    case 'graphics':
      return applyGraphics(rom, preview.files, ctx.plan, opt.blank);
    case 'mapped': {
      const place = placed(preview.files.keys(), step.assignment.rules);
      if (!place.size) return { ...ok, ok: false, errors: ['Nothing selected – no file of the package is assigned to a folder.'] };
      const proj = loadProject(rom) ?? emptyProject();
      for (const [from, to] of place) { proj.files.set(to, preview.files.get(from)!); claim('uber', to); }
      for (const c of step.assignment.calls) {
        const list = proj.list[c.ctx].get(c.num) ?? [];
        if (!list.some((x) => x.file === c.file)) list.push({ file: c.file, bytes: [] });
        proj.list[c.ctx].set(c.num, list);
      }
      return saveProject(rom, proj);
    }
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

// the routines (routines/ folders) going with the sprites or the blocks: those they call; ones nobody
// calls go with both
function partRoutines(preview: ReadyPreview, upload: Upload, kind: 'sprite' | 'block'): string[] {
  const all = [...upload.files.keys()].filter((f) => /(^|\/)routines\/[^/]+\.asm$/i.test(f));
  const files = (k: string) => preview.parts.filter((p) => p.kind === k).map((p) => p.file);
  const mine = routinesCalled(upload, all, files(kind));
  const other = routinesCalled(upload, all, files(kind === 'sprite' ? 'block' : 'sprite'));
  return all.filter((r) => mine.includes(r) || !other.includes(r));
}

// ---------- removing ----------

// the package and everything it brought (songs too); files another package brought as well stay
export function removePackage(rom: Rom, id: string, blank: number[]): Promise<string[]> {
  return uninstallPackage(rom, id, blank);
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

// ---------- files and manuals ----------

// the files of an installed package (kept with its record in the editor data), null if there are none
export function packageFiles(rom: Rom, pkg: Package): Map<string, Uint8Array> | null {
  const a = packageArchive(rom, pkg);
  return a ? new Map(Object.entries(unzipSync(a))) : null;
}

// the installed packages that brought files of a tool project (uber = UberASM, blocks, pixi = sprites)
// and have a manual, with their files: the manual comes and goes with its package (and its undo)
export function packageManuals(rom: Rom, tool: 'uber' | 'blocks' | 'pixi'): { pkg: Package; files: Map<string, Uint8Array> }[] {
  const out: { pkg: Package; files: Map<string, Uint8Array> }[] = [];
  for (const pkg of listPackages(rom)) {
    if (!pkg[tool].files.length) continue;
    const files = packageFiles(rom, pkg);
    if (files && packageDocs(files).length) out.push({ pkg, files });
  }
  return out;
}
