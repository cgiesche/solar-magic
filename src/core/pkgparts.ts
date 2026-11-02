// The part adapters (see CONTEXT.md: Part): one per part kind – patch, UberASM file, block, sprite, song,
// sound effect, graphics part – all with the same shape:
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
import { uploadSource, effectiveDefines, packUpload, type FileDefines, type Upload } from './patchpkg.ts';
import { suggestCalls, placed, type PkgRules } from './pkgmap.ts';
import { isSongText, songsFromFiles, loadMusicProject, emptyMusicProject, addSongs, addSfx, nextFreeSong, folders as musicFolders, saveMusicProject, hasAmk, musicEntry } from './music.ts';
import { pixiParts, planPixiUpload, applyPixiUpload, linkedDefines, hexNum, type PixiPlan } from './pixipkg.ts';
import { parseCfg, parseJsonCfg, readPixiList, FOLDER } from './pixi.ts';
import { bowsieUploadSprites, applyBowsieUpload } from './bowsie.ts';
import { detectBlocks, applyBlocks, applyGraphics, routinesCalled, planPackage, plannedFgTiles, type DetectedBlock, type DetectedGraphics, type PackagePlan } from './pkgplan.ts';
import { loadProject, saveProject, emptyProject, projectFromFiles, addCall, isUberList, type UberProject } from './uberproject.ts';
import { setLevelMusic } from './patches.ts';
import { findSfx, sfxNumbers, sfxLinks, isSfxList, sfxName, type FoundSfx, type SfxBank, type SfxLink } from './sfx.ts';
import { ALL, CONTEXTS, OTHER, type UberContext } from './uberasm.ts';
import type { Claim } from './pkgreg.ts';
import type { Level } from './level.ts';
import { callistoAsm, toolFiles, PATCH_DEFINES, type CallistoProject } from './callisto.ts';

// ---------- what the adapters detect ----------

interface PartBase<K extends PartKind> { kind: K; name: string; file: string }
export type GraphicsType = 'map16' | 'exgfx' | 'pal' | 'palmask' | 'sharedpal' | 'globalanim' | 'globalgfx';
// one part of an upload; file: its main file (path in the upload)
export type PreviewPart =
  | PartBase<'patch'> & { candidates: string[] } // the main files to choose from (the upload doesn't say which)
  | PartBase<'uberasm'> & { ctx: UberContext; folder: UberProject | null } // folder: the UberASM Tool folder it is in, installed as a whole
  | PartBase<'block'> & { found: DetectedBlock[] } // one per tile a GPS list.txt puts it on, else one without a tile
  | PartBase<'sprite'>
  | PartBase<'owsprite'>
  | PartBase<'music'>
  | PartBase<'sfx'> & { bank: SfxBank; rel: string; author: number | null } // rel: its path below the bank's folder; author: its number in the upload's list
  | PartBase<'graphics'> & { type: GraphicsType };
export type PartOf<K extends PartKind> = Extract<PreviewPart, { kind: K }>;

export interface PreviewBase { name: string; fileName: string; files: Map<string, Uint8Array> }
export interface ReadyPreview extends PreviewBase {
  status: 'ready';
  parts: PreviewPart[];
  upload: Upload | null; // the upload's code (null: it has no .asm)
  samples: string[]; // its sample levels (.mwl)
  unclaimed: string[]; // files no part takes: not installed
  docs: string[]; // the package's manuals (readme)
  callisto: CallistoProject | null; // the Callisto project it is
  notes: string[]; // what of it is left out, and why
}

// what every adapter's claims start from (worked out once per upload)
export interface Detection {
  files: Map<string, Uint8Array>;
  paths: string[];
  upload: Upload | null;
  included: Set<string>; // files some .asm file includes
  docs: string[];
  graphics: DetectedGraphics;
  callisto: CallistoProject | null; // a Callisto project: its patches and tool folders are as it says
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
  samples?: string[]; // of several sample levels: these (their files) as the levels the plan offers them as
}

// what the adapters apply: the preview, the options and where the parts go in this ROM
export interface InstallContext {
  preview: ReadyPreview; // with the sound effects' defines set in its files
  opt: InstallOptions;
  plan: PackagePlan; // blocks, Map16 tiles, ExGFX and their links
  sprites: PixiPlan | null; // the sprites' numbers and the defines naming them
  sfx: SfxPlan; // the sound effects' numbers and the defines playing them
}

// the numbers of an upload's sound effects (-1: none free) and the defines of its code playing them
export interface SfxPlan { sfx: (FoundSfx & { num: number })[]; links: SfxLink[] }

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
// (in a Callisto project, code is a patch by patches.toml or in a tool's folder)
const loose = (d: Detection) => d.callisto ? [] : d.upload?.asmFiles.filter((p) => !d.included.has(p) && !SHARED_CODE.test(p)) ?? [];
// a file in one of a Callisto project's tool folders (UberASM Tool, GPS, PIXI): that tool's
const inToolFolder = (d: Detection, f: string) => !!d.callisto && Object.values(d.callisto.tools).some((t) => t && f.startsWith(t.folder));
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

// a patch of a Callisto project: its files with the header Callisto generates, the defines it passes
function callistoPatch(upload: Upload, p: CallistoProject, main: string): PatchSource {
  const files = new Map<string, Uint8Array | string>(upload.files);
  files.set('callisto.asm', callistoAsm(p));
  return { name: base(main).replace(/\.(asm|asar)$/i, ''), main, files, defines: { ...PATCH_DEFINES }, settings: {} };
}

const patch: PartAdapter<'patch'> = {
  kind: 'patch',
  // every .asm that nothing includes and isn't shared code, when no other part takes it; a Callisto
  // project's: those of its patches.toml
  claims: (d) => d.callisto
    ? d.callisto.patches.map((p) => ({ file: p, rank: RANK.folder, part: { kind: 'patch', name: base(p).replace(/\.(asm|asar)$/i, ''), file: p, candidates: [p] } }))
    : loose(d).map((p) => ({ file: p, rank: RANK.fallback, part: { kind: 'patch', name: d.upload!.name, file: p, candidates: [p] } })),
  // one patch at most: the main file of the upload, or – when it has no other parts – one to choose; a
  // Callisto project's all, in its order
  finish(mine, others, d) {
    if (d.callisto) { const order = d.callisto.patches; return mine.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file)); }
    const files = mine.map((p) => p.file);
    const main = d.upload?.main && files.includes(d.upload.main) ? d.upload.main : files.length === 1 ? files[0] : null;
    if (main) return [{ ...mine.find((p) => p.file === main)!, candidates: [main] }];
    return mine.length && !others.length ? [{ ...mine[0], candidates: files }] : [];
  },
  apply(rom, mine, { preview, opt }) {
    const c = preview.callisto;
    if (!c) return applyPatch(rom, patchSource(preview.upload!, preview.fileName, opt.patch?.main ?? mine[0].file, opt.patch?.values ?? {}));
    // a Callisto project's one after the other (their sources are the package's)
    const warnings: string[] = [], prints: string[] = [];
    for (const p of mine) {
      const r = applyPatch(rom, callistoPatch(preview.upload!, c, p.file));
      warnings.push(...r.warnings.map((w) => `${p.file}: ${w}`));
      prints.push(...r.prints);
      if (!r.ok) return { ok: false, errors: r.errors.map((e) => `${p.file}: ${e}`), warnings, prints };
    }
    return { ...ok, warnings, prints };
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

const uberasm: PartAdapter<'uberasm'> = {
  kind: 'uberasm',
  claims(d) {
    if (!d.upload) return [];
    const out: FileClaim[] = [];
    // an UberASM Tool folder (its list.txt has the sections of UberASM Tool): all its files; a Callisto
    // project's where it says, its list maybe elsewhere
    const tool = d.callisto?.tools.uberasm;
    const list = tool ? tool.list : d.paths.find((p) => /^([^/]+\/)?list\.txt$/i.test(p));
    if (list && isUberList(dec.decode(d.files.get(list)!))) {
      try {
        const root = tool ? tool.folder : list.slice(0, list.length - 'list.txt'.length);
        const folder = projectFromFiles(tool ? new Map([...d.paths.filter((p) => p.startsWith(root)).map((p) => [p.slice(root.length), d.files.get(p)!] as const), ['list.txt', d.files.get(list)!]]) : d.files);
        if (tool) out.push({ file: list, rank: RANK.folder });
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
      for (const k of OTHER) proj.list[k] ??= folder.list[k];
    }
    // a Callisto project's code: its header and the shared code it includes
    if (preview.callisto) for (const [f, c] of toolFiles(preview.callisto, preview.files)) { proj.files.set(f, c); claim('uberasm', f); }
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
    const found = detectBlocks(d.files, d.callisto?.tools.gps);
    const out: FileClaim[] = found.list ? [{ file: found.list, rank: RANK.content }] : [];
    for (const f of new Set(found.blocks.map((b) => b.file))) out.push({ file: f, rank: RANK.content, part: { kind: 'block', name: base(f), file: f, found: found.blocks.filter((b) => b.file === f) } });
    return out;
  },
  apply(rom, _mine, { preview, opt, plan, sprites }, claim) {
    const defines: FileDefines = sprites ? linkedDefines(sprites) : new Map();
    const drawn = new Set(plannedFgTiles(plan));
    const extra = preview.callisto ? toolFiles(preview.callisto, preview.files) : undefined;
    return applyBlocks(rom, preview.upload!, plan.blocks, defines, partRoutines(preview, 'block'), opt.blank, opt.tileWords, drawn, (f) => claim('block', f), extra);
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
    const pixi = d.callisto?.tools.pixi;
    for (const s of pixiParts(d.upload).sprites) {
      if (d.callisto && !(pixi && s.file.startsWith(pixi.folder))) continue; // (a Callisto project's are in its PIXI folder)
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

// ---------- overworld sprites ----------

const owsprite: PartAdapter<'owsprite'> = {
  kind: 'owsprite',
  // BOWSIE's sprites (an .asm with init and main and BOWSIE's names), each with the files of its folder but the manuals
  claims(d) {
    if (!d.upload || d.callisto) return [];
    const out: FileClaim[] = [];
    for (const f of bowsieUploadSprites(d.files)) {
      out.push({ file: f, rank: RANK.content, part: { kind: 'owsprite', name: base(f).replace(/\.asm$/i, ''), file: f } });
      const dir = dirOf(f);
      for (const p of d.paths) if (p !== f && dirOf(p) === dir && !d.docs.includes(p)) out.push({ file: p, rank: RANK.content, of: f });
    }
    return out;
  },
  apply(rom, mine, { preview }, claim) {
    const others = new Set(preview.parts.filter((p) => p.kind !== 'owsprite').map((p) => p.file));
    return applyBowsieUpload(rom, preview.files, mine.map((p) => p.file), others, (f) => claim('owsprite', f));
  },
};

// ---------- songs and sound effects ----------

// the songs and sound effects of the package go into the music project together: one AddmusicK run –
// songs with the next free numbers, the first playing in the current level, sound effects as planned
async function applyAmk(rom: Rom, { preview, opt, sfx }: InstallContext): Promise<ApplyResult> {
  if (hasAmk(rom) && !musicEntry(rom)) return { ...ok, ok: false, errors: ['AddmusicK was inserted by another tool – songs and sound effects cannot be added here.'] };
  const proj = loadMusicProject(rom) ?? emptyMusicProject();
  const songs = partsOf(preview, 'music').length ? songsFromFiles(preview.fileName, preview.files, musicFolders(proj)) : null;
  let first: number | null = null;
  if (songs) {
    const num = nextFreeSong(proj);
    if (num < 0) return { ...ok, ok: false, errors: ['All song numbers up to FF are used.'] };
    first = addSongs(proj, songs, num)[0].num;
  }
  const full = sfx.sfx.filter((x) => x.num < 0);
  if (full.length) return { ...ok, ok: false, errors: full.map((x) => `${x.rel}: all sound effect numbers of ${x.bank} up to FF are used.`) };
  if (sfx.sfx.length) addSfx(proj, preview.name, sfx.sfx.map((x) => ({ ...x, data: preview.files.get(x.file)! })));
  const r = await saveMusicProject(rom, proj);
  const prints = r.log.trim() ? [`AddmusicK output:\n${r.log.trimEnd()}`] : [];
  if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, prints };
  if (first !== null && opt.level !== null) setLevelMusic(rom, opt.level, first);
  const moved = sfx.sfx.filter((x) => x.author !== null && x.author !== x.num).map((x) => `Sound effect ${sfxName(x.rel)}: ${x.bank} ${hexNum(x.num)} instead of the author's ${hexNum(x.author!)}, which is taken${sfx.links.some((l) => sfx.sfx[l.sfx] === x) ? '' : ' – no define of the package\'s code found to set to it'}.`);
  return { ...ok, prints, warnings: [...r.warnings, ...(songs?.missing ?? []).map((m) => `Missing sample: ${m}`), ...moved] };
}

const music: PartAdapter<'music'> = {
  kind: 'music',
  claims: (d) => d.paths.filter((p) => /\.txt$/i.test(p) && isSongText(dec.decode(d.files.get(p)!)))
    .map((p) => ({ file: p, rank: RANK.type, part: { kind: 'music', name: base(p).replace(/\.txt$/i, ''), file: p } })),
  apply: (rom, _mine, ctx) => applyAmk(rom, ctx),
};

const sfx: PartAdapter<'sfx'> = {
  kind: 'sfx',
  // the .txt files in a folder 1DF9 or 1DFC (AddmusicK's), with the list numbering them
  claims(d) {
    const found = findSfx(d.files);
    if (!found.length) return [];
    return [
      ...found.map((s): FileClaim => ({ file: s.file, rank: RANK.type, part: { kind: 'sfx', name: sfxName(s.rel), file: s.file, bank: s.bank, rel: s.rel, author: s.author } })),
      ...d.paths.filter(isSfxList).map((file) => ({ file, rank: RANK.type })),
    ];
  },
  // (with songs: inserted with them)
  apply: (rom, _mine, ctx) => (partsOf(ctx.preview, 'music').length ? ok : applyAmk(rom, ctx)),
};

// numbers for the package's sound effects in this ROM and the defines of its code playing them
export function planSfx(rom: Rom, preview: ReadyPreview): SfxPlan {
  const found = partsOf(preview, 'sfx').map(({ file, bank, rel, author }) => ({ file, bank, rel, author }));
  if (!found.length) return { sfx: [], links: [] };
  let proj = null;
  try { proj = loadMusicProject(rom); } catch { /* its sources are missing: inserting says so */ }
  const nums = sfxNumbers(proj?.sfx ?? [], found);
  return { sfx: found.map((f, i) => ({ ...f, num: nums[i] })), links: sfxLinks(preview.files, found) };
}

// per file of the package, the defines playing one of its sound effects under another number than the
// author's, set to its number
export function sfxDefines(plan: SfxPlan): FileDefines {
  const byFile: FileDefines = new Map();
  for (const l of plan.links) {
    const s = plan.sfx[l.sfx];
    if (s.num < 0 || s.num === s.author) continue;
    byFile.set(l.file, { ...byFile.get(l.file), [l.define]: hexNum(s.num) });
  }
  return byFile;
}

// ---------- graphics ----------

const GRAPHICS_TYPES: GraphicsType[] = ['map16', 'exgfx', 'pal', 'palmask', 'sharedpal', 'globalanim', 'globalgfx'];
// a Callisto project's global GFX files are those of the Graphics folder next to its output ROM
const inProjectGraphics = (d: Detection, type: GraphicsType, f: string) => type !== 'globalgfx' || !d.callisto?.graphics || f.startsWith(d.callisto.graphics);

const graphics: PartAdapter<'graphics'> = {
  kind: 'graphics',
  // Map16 tiles, ExGFX, palettes, shared palettes, global animation and global GFX files; the Lunar Magic level files go with the package (its sample levels)
  // (in a Callisto project not those in a tool's folder, which are its code's data)
  claims: (d) => [
    ...GRAPHICS_TYPES.flatMap((type) => d.graphics[type].filter((f) => !inToolFolder(d, f) && inProjectGraphics(d, type, f)).map((f): FileClaim => ({ file: f, rank: RANK.type, part: { kind: 'graphics', name: base(f), file: f, type } }))),
    ...d.graphics.mwls.map((file) => ({ file, rank: RANK.type })),
  ],
  apply: (rom, _mine, { preview, opt, plan }) => applyGraphics(rom, preview.files, plan, opt.blank),
};

// ---------- all of them ----------

export const PART_ADAPTERS: { [K in PartKind]: PartAdapter<K> } = { patch, uberasm, block, sprite, owsprite, music, sfx, graphics };
// an adapter by its kind, for loops over all kinds
export const partAdapter = (k: PartKind) => PART_ADAPTERS[k] as PartAdapter<PartKind>;
// who wins a file at equal rank
export const DETECT_ORDER: PartKind[] = ['graphics', 'sfx', 'music', 'owsprite', 'uberasm', 'block', 'sprite', 'patch'];
// the order of applying: the patch first, the sprites' numbers before the blocks spawning them, the
// Map16 tiles after the blocks on them; AddmusicK after the UberASM code (as Callisto has it: it fits its
// NMI changes to a hijack of UberASM's that is there)
export const INSTALL_ORDER: PartKind[] = ['patch', 'uberasm', 'sprite', 'block', 'owsprite', 'music', 'sfx', 'graphics'];
// the order of the preview's list
export const PART_ORDER: PartKind[] = ['patch', 'uberasm', 'block', 'sprite', 'owsprite', 'music', 'sfx', 'graphics'];

// the graphics parts and the sample levels of a preview, as pkgplan.ts takes them
function previewGraphics(p: ReadyPreview): DetectedGraphics {
  const g: DetectedGraphics = { map16: [], exgfx: [], pal: [], palmask: [], sharedpal: [], globalanim: [], globalgfx: [], mwls: p.samples };
  for (const x of partsOf(p, 'graphics')) g[x.type].push(x.file);
  return g;
}

// where the package's blocks, Map16 tiles and ExGFX would go in this ROM, and how they link up
// (tilesets: this ROM's words of FG tiles 000-1FF per tileset, see PlanInput)
export function planUpload(rom: Rom, preview: ReadyPreview, blank: number[], tilesets?: number[][][]): PackagePlan {
  return planPackage(rom, { files: preview.files, blocks: partsOf(preview, 'block').flatMap((b) => b.found), graphics: previewGraphics(preview), tilesets }, blank);
}

// where every part goes in this ROM; preview: with the sound effects' defines set in its files, sfx: their
// numbers and links, planned on the author's files (planSfx, sfxDefines)
export function planInstall(rom: Rom, preview: ReadyPreview, opt: InstallOptions, sfx: SfxPlan): InstallContext {
  const sprites = partsOf(preview, 'sprite').map((s) => s.file);
  return {
    preview, opt,
    plan: opt.plan ?? planUpload(rom, preview, opt.blank),
    sprites: sprites.length && preview.upload ? planPixiUpload(rom, preview.upload, (f) => sprites.includes(f), pixiListed(preview)) : null,
    sfx,
  };
}

// the numbers the package's PIXI list gives its sprites, by the sprite's file: a Callisto project's list
// of its PIXI folder, else any list.txt
export function pixiListed(preview: ReadyPreview): Map<string, number> {
  const out = new Map<string, number>();
  const sprites = partsOf(preview, 'sprite').map((s) => s.file);
  const pixi = preview.callisto?.tools.pixi;
  const lists = pixi ? (pixi.list ? [pixi.list] : []) : [...preview.files.keys()].filter((f) => /(^|\/)list\.txt$/i.test(f));
  for (const f of lists) {
    for (const e of readPixiList(dec.decode(preview.files.get(f)!))) {
      const dir = pixi ? pixi.folder + FOLDER[e.kind] : dirOf(f);
      const file = sprites.find((s) => s === dir + e.file || s.endsWith('/' + e.file));
      if (file && !out.has(file)) out.set(file, e.num);
    }
  }
  return out;
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


