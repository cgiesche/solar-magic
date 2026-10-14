// The part adapters (see CONTEXT.md: Part): one per part kind – patch, UberASM file, block, sprite, song,
// graphics part – all with the same shape:
// - claims: what of an upload it would take, file by file: a part's main file, or a file going with one
//   part (`of`) or with the package (a GPS list.txt, the sample level). Each claim has a rank: by file
//   type, by folder (a tool folder's list.txt), by content (a block, a sprite and its folder), as code
//   (UberASM) or as the fallback (a patch). inspectFiles (packages.ts) gives every file to its best
//   claim, deciding per file (ADR 0002);
// - finish: the parts it keeps of those it won (one patch at most);
// - apply: puts its parts into the ROM as planned (planInstall: blocks and graphics by the package plan of
//   pkgplan.ts, sprites by their numbers) and reports every tool-project file it writes through `claim`
//   (pkgreg.ts), also one that was there already.
// The single assignments – a call to a level, a block to a tile, a sprite to a number – are the tool
// projects' own (uberproject.ts addCall, blocks.ts assignBlock, pixi.ts assignSprite), used by
// installing and the configuration tabs alike. The sections of the package record are pkgsections.ts.

import type { Rom } from './rom.ts';
import type { ApplyResult, PatchSource } from './patchapply.ts';
import { applyPatch } from './patchapply.ts';
import type { PartKind } from './parts.ts';
import { uploadSource, effectiveDefines, packUpload, type Upload } from './patchpkg.ts';
import { suggestCalls, placed, type PkgRules } from './pkgmap.ts';
import { isSongText, songsFromFiles, loadMusicProject, emptyMusicProject, addSongs, nextFreeSong, folders as musicFolders, saveMusicProject, hasAmk, musicEntry } from './music.ts';
import { pixiParts, planPixiUpload, applyPixiUpload, linkedDefines, type PixiPlan } from './pixipkg.ts';
import { parseCfg, parseJsonCfg } from './pixi.ts';
import { detectBlocks, applyBlocks, applyGraphics, routinesCalled, planPackage, type DetectedBlock, type DetectedGraphics, type PackagePlan } from './pkgplan.ts';
import { loadProject, saveProject, emptyProject, projectFromFiles, addCall, isUberList, type UberProject } from './uberproject.ts';
import { setLevelMusic } from './patches.ts';
import { map16Targets } from './map16file.ts';
import { ALL, type UberContext } from './uberasm.ts';
import type { Claim } from './pkgreg.ts';
import type { Level } from './level.ts';

// ---------- what the adapters detect ----------

interface PartBase<K extends PartKind> { kind: K; name: string; file: string }
export type GraphicsType = 'map16' | 'exgfx' | 'pal' | 'palmask';
// one part of an upload; file: its main file (path in the upload)
export type PreviewPart =
  | PartBase<'patch'> & { candidates: string[] } // the main files to choose from (the upload doesn't say which)
  | PartBase<'uberasm'> & { ctx: UberContext; folder: UberProject | null } // folder: the UberASM Tool folder it is in, installed as a whole
  | PartBase<'block'> & { found: DetectedBlock[] } // one per tile a GPS list.txt puts it on, else one without a tile
  | PartBase<'sprite'>
  | PartBase<'music'>
  | PartBase<'graphics'> & { type: GraphicsType };
export type PartOf<K extends PartKind> = Extract<PreviewPart, { kind: K }>;

export interface PreviewBase { name: string; fileName: string; files: Map<string, Uint8Array> }
export interface ReadyPreview extends PreviewBase {
  status: 'ready';
  parts: PreviewPart[];
  upload: Upload | null; // the upload's code (null: it has no .asm)
  sample: string | null; // its sample level (.mwl)
  unclaimed: string[]; // files no part takes: not installed
  docs: string[]; // the package's manuals (readme)
}

// what every adapter's claims start from (worked out once per upload)
export interface Detection {
  files: Map<string, Uint8Array>;
  paths: string[];
  upload: Upload | null;
  included: Set<string>; // files some .asm file includes
  docs: string[];
  graphics: DetectedGraphics;
}

// how sure a claim is, best first; equal ranks go to the adapter first in DETECT_ORDER, a part before a
// file going with one
export const RANK = { type: 0, folder: 1, content: 2, code: 3, fallback: 4 } as const;
export interface FileClaim { file: string; rank: number; part?: PreviewPart; of?: string }

// ---------- installing ----------

// what goes where for a package assigned by hand: package node → UberASM project folder (null: left
// out), and the list.txt lines of its resource files
export interface ManualAssignment { rules: PkgRules; calls: { file: string; ctx: UberContext; num: number }[] }

export interface InstallOptions {
  level: number | null; // the current level: UberASM level code runs there, songs play there, a block package's graphics load there
  blank: number[]; // tile words of an empty Map16 tile
  tileWords(tile: number): number[]; // the words of a Map16 tile, for the graphics of new block tiles (from their acts like)
  patch?: { main?: string; values?: Record<string, string> }; // the patch part's main file and settings
  assignment?: ManualAssignment; // a package assigned by hand (default: the suggestion)
  plan?: PackagePlan; // where blocks, Map16 tiles and ExGFX go, with their links (default: planUpload's)
  setup?: boolean; // the level setup for `level`: the package's ExGFX in its slots, its colors (default: on)
  cgram?: Uint8Array; // the colors of `level` now (levelColors), base of its own palette for the setup
  wram?: Uint8Array; // the WRAM of `level` after its load: RAM frames of animations come along from it
  sample?: Level; // replace this level (the current one, number `level`) by the package's sample level
}

// what the adapters apply: the preview, the options and where the parts go in this ROM
export interface InstallContext {
  preview: ReadyPreview;
  opt: InstallOptions;
  plan: PackagePlan; // blocks, Map16 tiles, ExGFX and their links
  sprites: PixiPlan | null; // the sprites' numbers and the defines naming them
}

export interface PartAdapter<K extends PartKind> {
  kind: K;
  claims(d: Detection): FileClaim[];
  finish?(mine: PartOf<K>[], others: PreviewPart[], d: Detection): PartOf<K>[];
  apply(rom: Rom, mine: PartOf<K>[], ctx: InstallContext, claim: Claim): ApplyResult | Promise<ApplyResult>;
}

const dec = new TextDecoder();
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const ok: ApplyResult = { ok: true, errors: [], warnings: [], prints: [] };
// shared code: goes with the parts using it
export const SHARED_CODE = /(^|\/)(library|routines|other)\//i;
const loose = (d: Detection) => d.upload?.asmFiles.filter((p) => !d.included.has(p) && !SHARED_CODE.test(p)) ?? [];
export const partsOf = <K extends PartKind>(p: ReadyPreview, k: K) => p.parts.filter((x): x is PartOf<K> => x.kind === k);

// ---------- patch ----------

// built-in editor patches a patch.json asks for (every opened ROM has them)
export function ensureRequirements(upload: Upload): void {
  for (const req of upload.manifest?.requires ?? []) if (req !== 'smwe' && req !== 'smwx') throw new Error(`Unknown requirement “${req}” in patch.json`);
}

// the patch of an upload with its settings, its files kept with the editor data (to reapply it)
export function patchSource(upload: Upload, fileName: string, main: string, values: Record<string, string>): PatchSource {
  ensureRequirements(upload);
  const src = uploadSource(upload, main, effectiveDefines(upload, values));
  src.settings = values;
  src.archive = packUpload({ fileName, files: [...upload.files], main });
  return src;
}

const patch: PartAdapter<'patch'> = {
  kind: 'patch',
  // every .asm that nothing includes and isn't shared code, when no other part takes it
  claims: (d) => loose(d).map((p) => ({ file: p, rank: RANK.fallback, part: { kind: 'patch', name: d.upload!.name, file: p, candidates: [p] } })),
  // one patch at most: the main file of the upload, or – when it has no other parts – one to choose
  finish(mine, others, d) {
    const files = mine.map((p) => p.file);
    const main = d.upload?.main && files.includes(d.upload.main) ? d.upload.main : files.length === 1 ? files[0] : null;
    if (main) return [{ ...mine.find((p) => p.file === main)!, candidates: [main] }];
    return mine.length && !others.length ? [{ ...mine[0], candidates: files }] : [];
  },
  apply(rom, [p], { preview, opt }) {
    return applyPatch(rom, patchSource(preview.upload!, preview.fileName, opt.patch?.main ?? p.file, opt.patch?.values ?? {}));
  },
};

// ---------- UberASM ----------

// UberASM code: entry labels and no hijack/free space of its own
function isUberText(src: string): boolean {
  const st = src.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
  return st.some((l) => /^(init|main|load|end|nmi)\s*:/i.test(l)) && !st.some((l) => /^(org|freecode|freedata|autoclean|pushpc|lorom|sa1rom|hirom)\b/i.test(l));
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
function placeFiles(preview: ReadyPreview, main: string, mainText: string, folder: string): Map<string, Uint8Array> {
  const others = new Set(preview.parts.map((p) => p.file).filter((f) => f !== main));
  const out = new Map<string, Uint8Array>();
  for (const [f, c] of preview.upload!.files) {
    if (!/\.(asm|bin)$/i.test(f) || others.has(f)) continue;
    out.set(placeOf(f, folder), f === main ? new TextEncoder().encode(mainText) : c);
  }
  return out;
}

const CONTEXTS: UberContext[] = ['level', 'gamemode', 'overworld'];

const uberasm: PartAdapter<'uberasm'> = {
  kind: 'uberasm',
  claims(d) {
    if (!d.upload) return [];
    const out: FileClaim[] = [];
    // an UberASM Tool folder (its list.txt has the sections of UberASM Tool): all its files
    const list = d.paths.find((p) => /^([^/]+\/)?list\.txt$/i.test(p));
    if (list && isUberList(dec.decode(d.files.get(list)!))) {
      try {
        const folder = projectFromFiles(d.files);
        const root = list.slice(0, list.length - 'list.txt'.length);
        const mains = new Map([...folder.files.keys()].flatMap((f) => {
          const m = /^(level|gamemode|overworld)\/[^/]+\.asm$/i.exec(f);
          return m ? [[root + f, m[1].toLowerCase() as UberContext] as const] : [];
        }));
        for (const p of d.paths.filter((x) => x.startsWith(root)).sort()) {
          const ctx = mains.get(p);
          out.push({ file: p, rank: RANK.folder, part: ctx ? { kind: 'uberasm', name: base(p), file: p, ctx, folder } : undefined });
        }
      } catch { /* not a tool folder after all */ }
    }
    // code by its folder (level/, gamemode/, overworld/) or its content
    for (const p of loose(d)) {
      const ctx = /(^|\/)(level|gamemode|overworld)\/[^/]+$/i.exec(p)?.[2].toLowerCase() as UberContext | undefined;
      if (ctx || isUberText(dec.decode(d.files.get(p)!))) out.push({ file: p, rank: RANK.code, part: { kind: 'uberasm', name: base(p), file: p, ctx: ctx ?? 'level', folder: null } });
    }
    return out;
  },
  apply(rom, mine, { preview, opt }, claim) {
    const proj = loadProject(rom) ?? emptyProject();
    // a tool folder as it is: its files, its list.txt
    for (const folder of new Set(mine.flatMap((p) => (p.folder ? [p.folder] : [])))) {
      for (const [f, c] of folder.files) if (f !== 'list.txt') { proj.files.set(f, c); claim('uberasm', f); }
      for (const ctx of CONTEXTS) for (const [num, cs] of folder.list[ctx]) for (const c of cs) addCall(proj, ctx, num, c.file, c.bytes);
      for (const k of ['global', 'statusbar', 'macrolib'] as const) proj.list[k] ??= folder.list[k];
    }
    // a file: into the folder of its context, with what it needs; level code in the level chosen, game
    // mode and overworld map as the docs say ("0C file.asm"), else 14 and the main map
    for (const p of mine) {
      if (p.folder) continue;
      const folder = `${p.ctx}/`;
      const text = uploadSource(preview.upload!, p.file, {}).files.get(p.file) as string;
      for (const [f, c] of placeFiles(preview, p.file, text, folder)) { proj.files.set(f, c); claim('uberasm', f); }
      const file = placeOf(p.file, folder);
      const num = p.ctx === 'level' ? opt.level ?? ALL : suggestCalls(preview.files, new Map([[p.file, file]]), { level: ALL, gamemode: 0x14, overworld: 0 })[0].num;
      addCall(proj, p.ctx, num, file);
    }
    return saveProject(rom, proj);
  },
};

// a package assigned by hand (tool folders next to folders they include): its files where the
// assignment puts them, its calls
export function applyAssignment(rom: Rom, files: Map<string, Uint8Array>, a: ManualAssignment, claim: Claim): ApplyResult {
  const place = placed(files.keys(), a.rules);
  if (!place.size) return { ...ok, ok: false, errors: ['Nothing selected – no file of the package is assigned to a folder.'] };
  const proj = loadProject(rom) ?? emptyProject();
  for (const [from, to] of place) { proj.files.set(to, files.get(from)!); claim('uberasm', to); }
  for (const c of a.calls) addCall(proj, c.ctx, c.num, c.file);
  return saveProject(rom, proj);
}

// ---------- blocks ----------

// the routines (routines/ folders) going with the sprites or the blocks: those they call; ones nobody
// calls go with both
function partRoutines(preview: ReadyPreview, kind: 'sprite' | 'block'): string[] {
  const upload = preview.upload!;
  const all = [...upload.files.keys()].filter((f) => /(^|\/)routines\/[^/]+\.asm$/i.test(f));
  const files = (k: 'sprite' | 'block') => partsOf(preview, k).map((p) => p.file);
  const mine = routinesCalled(upload, all, files(kind));
  const other = routinesCalled(upload, all, files(kind === 'sprite' ? 'block' : 'sprite'));
  return all.filter((r) => mine.includes(r) || !other.includes(r));
}

const block: PartAdapter<'block'> = {
  kind: 'block',
  // named in a GPS list.txt or found by their content
  claims(d) {
    if (!d.upload) return [];
    const found = detectBlocks(d.files);
    const out: FileClaim[] = found.list ? [{ file: found.list, rank: RANK.content }] : [];
    for (const f of new Set(found.blocks.map((b) => b.file))) out.push({ file: f, rank: RANK.content, part: { kind: 'block', name: base(f), file: f, found: found.blocks.filter((b) => b.file === f) } });
    return out;
  },
  apply(rom, _mine, { preview, opt, plan, sprites }, claim) {
    const defines = sprites ? linkedDefines(sprites) : new Map<string, Record<string, string>>();
    const drawn = new Set(plan.map16 ? map16Targets(plan.map16.data, plan.map16.at) : []);
    return applyBlocks(rom, preview.upload!, plan.blocks, defines, partRoutines(preview, 'block'), opt.blank, opt.tileWords, drawn, (f) => claim('block', f));
  },
};

// ---------- sprites ----------

// the .asm a sprite's cfg/json names
function cfgAsm(upload: Upload, cfg: string): string | null {
  try {
    const t = dec.decode(upload.files.get(cfg)!);
    const c = /\.json$/i.test(cfg) ? parseJsonCfg(t, cfg) : parseCfg(t, cfg);
    return c.asm && upload.files.has(c.asm) ? c.asm : null;
  } catch { return null; }
}

const sprite: PartAdapter<'sprite'> = {
  kind: 'sprite',
  // PIXI sprites: cfg/json with their .asm, misc sprites by their folder; each with the files of its
  // folder (cfg/json next to it, files it includes) but the manuals
  claims(d) {
    if (!d.upload) return [];
    const out: FileClaim[] = [];
    for (const s of pixiParts(d.upload).sprites) {
      out.push({ file: s.file, rank: RANK.content, part: { kind: 'sprite', name: s.name, file: s.file } });
      const dir = dirOf(s.file);
      if (dir) for (const p of d.paths) if (p !== s.file && p.startsWith(dir) && !d.docs.includes(p)) out.push({ file: p, rank: RANK.content, of: s.file });
      const asm = /\.(json|cfg)$/i.test(s.file) ? cfgAsm(d.upload, s.file) : null;
      if (asm) out.push({ file: asm, rank: RANK.content, of: s.file });
    }
    return out;
  },
  apply(rom, _mine, { preview, sprites }, claim) {
    const others = new Set(preview.parts.filter((p) => p.kind !== 'sprite').map((p) => p.file));
    return applyPixiUpload(rom, preview.upload!, { ...sprites!, routines: partRoutines(preview, 'sprite') }, others, (f) => claim('sprite', f));
  },
};

// ---------- songs ----------

const music: PartAdapter<'music'> = {
  kind: 'music',
  claims: (d) => d.paths.filter((p) => /\.txt$/i.test(p) && isSongText(dec.decode(d.files.get(p)!)))
    .map((p) => ({ file: p, rank: RANK.type, part: { kind: 'music', name: base(p).replace(/\.txt$/i, ''), file: p } })),
  // the next free numbers, the first song playing in the current level
  async apply(rom, _mine, { preview, opt }) {
    if (hasAmk(rom) && !musicEntry(rom)) return { ...ok, ok: false, errors: ['AddmusicK was inserted by another tool – songs cannot be added here.'] };
    const proj = loadMusicProject(rom) ?? emptyMusicProject();
    const sf = songsFromFiles(preview.fileName, preview.files, musicFolders(proj));
    const num = nextFreeSong(proj);
    if (num < 0) return { ...ok, ok: false, errors: ['All song numbers up to FF are used.'] };
    const added = addSongs(proj, sf, num);
    const r = await saveMusicProject(rom, proj);
    const prints = r.log.trim() ? [`AddmusicK output:\n${r.log.trimEnd()}`] : [];
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, prints };
    if (opt.level !== null) setLevelMusic(rom, opt.level, added[0].num);
    return { ...ok, prints, warnings: [...r.warnings, ...sf.missing.map((m) => `Missing sample: ${m}`)] };
  },
};

// ---------- graphics ----------

const GRAPHICS_TYPES: GraphicsType[] = ['map16', 'exgfx', 'pal', 'palmask'];

const graphics: PartAdapter<'graphics'> = {
  kind: 'graphics',
  // Map16 tiles, ExGFX and palettes; the Lunar Magic level file goes with the package (its sample level)
  claims: (d) => [
    ...GRAPHICS_TYPES.flatMap((type) => d.graphics[type].map((f): FileClaim => ({ file: f, rank: RANK.type, part: { kind: 'graphics', name: base(f), file: f, type } }))),
    ...(d.graphics.mwl ? [{ file: d.graphics.mwl, rank: RANK.type }] : []),
  ],
  apply: (rom, _mine, { preview, opt, plan }) => applyGraphics(rom, preview.files, plan, opt.blank),
};

// ---------- all of them ----------

export const PART_ADAPTERS: { [K in PartKind]: PartAdapter<K> } = { patch, uberasm, block, sprite, music, graphics };
// an adapter by its kind, for loops over all kinds
export const partAdapter = (k: PartKind) => PART_ADAPTERS[k] as PartAdapter<PartKind>;
// who wins a file at equal rank
export const DETECT_ORDER: PartKind[] = ['graphics', 'music', 'uberasm', 'block', 'sprite', 'patch'];
// the order of applying: the patch first, the sprites' numbers before the blocks spawning them, the
// Map16 tiles after the blocks on them
export const INSTALL_ORDER: PartKind[] = ['patch', 'music', 'uberasm', 'sprite', 'block', 'graphics'];
// the order of the preview's list
export const PART_ORDER: PartKind[] = ['patch', 'uberasm', 'block', 'sprite', 'music', 'graphics'];

// the graphics parts and the sample level of a preview, as pkgplan.ts takes them
function previewGraphics(p: ReadyPreview): DetectedGraphics {
  const g: DetectedGraphics = { map16: [], exgfx: [], pal: [], palmask: [], mwl: p.sample };
  for (const x of partsOf(p, 'graphics')) g[x.type].push(x.file);
  return g;
}

// where the package's blocks, Map16 tiles and ExGFX would go in this ROM, and how they link up
export function planUpload(rom: Rom, preview: ReadyPreview, blank: number[]): PackagePlan {
  return planPackage(rom, { files: preview.files, blocks: partsOf(preview, 'block').flatMap((b) => b.found), graphics: previewGraphics(preview) }, blank);
}

// where every part goes in this ROM
export function planInstall(rom: Rom, preview: ReadyPreview, opt: InstallOptions): InstallContext {
  const sprites = partsOf(preview, 'sprite').map((s) => s.file);
  return {
    preview, opt,
    plan: opt.plan ?? planUpload(rom, preview, opt.blank),
    sprites: sprites.length && preview.upload ? planPixiUpload(rom, preview.upload, (f) => sprites.includes(f)) : null,
  };
}

// applies every part of the preview (run it in a package recording, pkgreg.ts, which gets `claim`);
// stops at the first that fails
export async function applyParts(rom: Rom, ctx: InstallContext, claim: Claim): Promise<ApplyResult> {
  const warnings: string[] = [], prints: string[] = [];
  for (const k of INSTALL_ORDER) {
    const mine = partsOf(ctx.preview, k);
    if (!mine.length) continue;
    const r = await partAdapter(k).apply(rom, mine, ctx, claim);
    warnings.push(...r.warnings);
    prints.push(...r.prints);
    if (!r.ok) return { ...r, warnings, prints };
  }
  return { ok: true, errors: [], warnings, prints };
}


