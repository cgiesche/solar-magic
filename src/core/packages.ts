// Packages (see CONTEXT.md): uploading one is the only way third-party content enters the ROM. This
// module owns the lifecycle behind a small interface:
// - inspectUpload: file name and bytes in, an upload preview out – the detected parts (with the patch
//   options of a patch part), a package to assign by hand, a level import, or a failure saying what was
//   found and what is missing;
// - installPackage: applies every part of a previewed upload and records what it brought as one package
//   (observed like pkgreg.ts does: the ROM's projects before and after); all or nothing;
// - reapplyPackagePatch: a package's patch with other settings;
// - importForPackage: a graphics file of an installed package imported, its number recorded with it.
// Detecting, planning and applying each part kind is its part adapter's (pkgparts.ts); recording what a
// package brought and removing it again is the registry's (pkgreg.ts uninstallPackage). The recorder is
// called only here.

import { zipSync, unzipSync } from 'fflate';
import { Rom } from './rom.ts';
import { reapplyPatch, type ApplyResult } from './patchapply.ts';
import { PART_KINDS, type PartKind, type ToolKind } from './parts.ts';
import { uploadFiles, uploadFromFiles, withDefines, type UploadCode } from './patchpkg.ts';
import { suggestMapping, placed, suggestCalls, packageDocs, type PkgSuggestion } from './pkgmap.ts';
import { detectGraphics, includedFiles, applyLevelSetup } from './pkgplan.ts';
import { setCustomPalette } from './patches.ts';
import { map16Targets } from './map16file.ts';
import { mwlSections, sampleLevel, type SampleLevel, type MwlSections } from './mwl.ts';
import { writeLevelList, setLevelSettings, levelSettings } from './exanim.ts';
import { planBgPack, applyBgPack, isLevelImport, parseMwl } from './bgpack.ts';
import { levelFrames } from './levelgfx.ts';
import { parseSprites, spriteSizes, loadLevel, readSecondaryEntrance, writeSecondaryEntrance, decodeSecondaryEntrance, exitIndex, SEC_LEVEL_HI, type Level } from './level.ts';
import { ExitGraph, isBlank, isOverworldExit } from './exitgraph.ts';
import { NO_FREE_ENTRANCE } from './entrances.ts';
import { saveLevel } from './save.ts';
import { sampleSlots, placeSampleMessages } from './pkgsamples.ts';
import { assignSlot } from './gfxslots.ts';
import { recordPackageChange, recordPackageChangeAsync, listPackages, packageArchive, type Package } from './pkgreg.ts';
import { uploadObjectText, objectTextNotes, isObjectTextFile } from './objtext.ts';
import { allOrNothing } from './romedit.ts';
import { callistoProject, includesCallistoHeader, sharedCode, type CallistoProject } from './callisto.ts';
import { replacedPatch, replacedNote } from './replaced.ts';
import { partAdapter, DETECT_ORDER, SHARED_CODE, planInstall, planSfx, sfxDefines, planUpload, applyParts, pixiListed, perLevelSprites, perLevelLeftOut, applyAssignment, patchSource, partsOf,
  type PreviewPart, type PreviewBase, type ReadyPreview, type Detection, type FileClaim, type InstallOptions, type InstallContext, type ManualAssignment, type SfxPlan } from './pkgparts.ts';

export type { PreviewPart, ReadyPreview, InstallOptions, ManualAssignment };
export { planUpload };

// tool folders next to folders they include (Retry System): assigned by hand, starting from the suggestion
export interface ManualPreview extends PreviewBase { status: 'manual'; suggestion: PkgSuggestion }
export type UploadPreview =
  | ReadyPreview
  | ManualPreview
  | PreviewBase & { status: 'level-import' } // a Lunar Magic level (.mwl): not a package
  | PreviewBase & { status: 'replaced'; notes: string[] } // only replaced patches: nothing to install
  | PreviewBase & { status: 'failed'; reason: string };

const dec = new TextDecoder();
const hx = (v: number) => v.toString(16).toUpperCase().padStart(3, '0');
const nameOf = (fileName: string) => fileName.replace(/\.[^.]*$/, '').split(/[\\/]/).pop()!;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : one.endsWith('h') ? 'es' : 's'}`;

// "2 sprites, 1 UberASM file, 1 song"
const COUNT_NOUN: Record<PartKind, string> = { patch: 'patch', uberasm: 'UberASM file', block: 'block', sprite: 'sprite', owsprite: 'overworld sprite', music: 'song', sfx: 'sound effect', graphics: 'graphics file' };
export function partsSummary(parts: PreviewPart[]): string {
  const n = new Map<PartKind, number>();
  for (const p of parts) n.set(p.kind, (n.get(p.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => plural(c, COUNT_NOUN[k])).join(', ');
}

export function inspectUpload(fileName: string, data: Uint8Array): UploadPreview {
  const name = nameOf(fileName);
  let files: Map<string, Uint8Array>;
  try { files = uploadFiles(fileName, data); } catch (e) {
    return { status: 'failed', name, fileName, files: new Map(), reason: e instanceof Error ? e.message : String(e) };
  }
  return inspectFiles(fileName, files);
}

// what a package (its files, paths relative to its root) is: every adapter claims files, each file goes
// to its best claim, decided by the file alone (ADR 0002)
export function inspectFiles(fileName: string, files: Map<string, Uint8Array>): UploadPreview {
  const name = nameOf(fileName);
  const head = { name, fileName, files };
  if (!files.size) return { ...head, status: 'failed', reason: 'The upload is empty.' };
  const paths = [...files.keys()];
  const asm = paths.filter((p) => /\.(asm|asar)$/i.test(p));
  // a Callisto project: one package as its configuration says; code of one without it can't be built
  let callisto: CallistoProject | null;
  try { callisto = callistoProject(files); } catch (e) { return { ...head, status: 'failed', reason: `Callisto configuration: ${e instanceof Error ? e.message : e}` }; }
  if (callisto?.missing.length) return { ...head, status: 'failed', reason: `The Callisto project’s patches.toml lists ${callisto.missing.join(', ')}, which the upload lacks.` };
  const lone = callisto ? undefined : asm.find((p) => includesCallistoHeader(dec.decode(files.get(p)!)) && !files.has(p.replace(/[^/]*$/, '') + 'callisto.asm') && !files.has('callisto.asm'));
  if (lone) return { ...head, status: 'failed', reason: `“${lone}” is part of a Callisto project (it includes the callisto.asm Callisto generates) – upload the whole project.` };
  const included = includedFiles(files);
  const graphics = detectGraphics(files, included);
  // a Lunar Magic level without code or songs: a level import, not a package
  if (isLevelImport(files)) return { ...head, status: 'level-import' };
  // UberASM Tool folders whose code includes folders next to them: placed by hand (from the suggestion)
  const sug = asm.length && !callisto ? suggestMapping(files) : null;
  if (sug?.extra.length) return { ...head, status: 'manual', suggestion: sug };

  const docs = packageDocs(files);
  let code: UploadCode | null = null;
  if (asm.length) {
    try { code = uploadFromFiles(fileName, files); } catch (e) {
      return { ...head, status: 'failed', reason: e instanceof Error ? e.message : String(e) };
    }
    // a patch with a manifest is one patch, whatever else it holds
    if (code.manifest) {
      const main = code.manifest.main;
      return { ...head, name: code.name, status: 'ready', parts: [{ kind: 'patch', name: code.name, file: main, candidates: [main] }], code, samples: [], unclaimed: [], docs, callisto: null, notes: [] };
    }
  }
  const d: Detection = { files, paths, code, included, docs, graphics, callisto };
  const won = resolveClaims(d);
  // each adapter's parts: those whose main file it won, the ones it keeps
  const found = new Map(DETECT_ORDER.map((k) => [k, won.parts.filter((p) => p.kind === k)]));
  let parts: PreviewPart[] = [];
  for (const k of DETECT_ORDER) {
    const a = partAdapter(k);
    const others = DETECT_ORDER.filter((o) => o !== k).flatMap((o) => found.get(o)!);
    const kept = a.finish ? a.finish(found.get(k)!, others, d) : found.get(k)!;
    found.set(k, kept);
    parts.push(...kept);
  }
  // patches whose work an editor patch already does: left out with a note
  const replaced = new Map<string, string>();
  parts = parts.flatMap((p): PreviewPart[] => {
    if (p.kind !== 'patch') return [p];
    const keep = p.candidates.filter((f) => {
      const r = replacedPatch(dec.decode(files.get(f)!));
      if (r) replaced.set(f, replacedNote(f, r));
      return !r;
    });
    return keep.length ? [{ ...p, file: keep.includes(p.file) ? p.file : keep[0], candidates: keep }] : [];
  });
  // the main files of parts left out are not installed
  const mains = new Set(parts.flatMap((p) => (p.kind === 'patch' ? p.candidates : [p.file])));
  for (const p of won.parts) if (!mains.has(p.file)) won.files.delete(p.file);
  parts = PART_KINDS.flatMap((k) => parts.filter((p) => p.kind === k));
  // sprites the package's PIXI list gives only per-level numbers: left out with a note
  const perLevel = code ? perLevelSprites(files, callisto, won.parts.filter((p) => p.kind === 'sprite').map((p) => p.file)) : new Map<string, string>();
  if (!parts.length) {
    if (perLevel.size) return { ...head, status: 'failed', reason: `Nothing to install. ${[...perLevel.values()].join(' ')}` };
    if (replaced.size) return { ...head, status: 'replaced', notes: [...replaced.values()] };
    if (!asm.length) return { ...head, status: 'failed', reason: `Found ${describe(paths)}, but no .asm file (patch, UberASM code, block or sprite), no AddmusicK song (.txt), no graphics and no Lunar Magic level (.mwl).` };
    return { ...head, status: 'failed', reason: `Found ${describe(paths)}, but nothing to install: the .asm files are only included by each other.` };
  }
  // shared code goes with the parts using it; what is left is not installed; a Callisto project's Lunar
  // Magic data and initial patch with a note
  const left = callisto?.left.filter((l) => files.has(l.file)) ?? [];
  const notes = [...left.map((l) => `Not part of the package: ${l.file} – ${l.what}.`), ...replaced.values(), ...perLevel.values()];
  const shared = new Set(callisto ? sharedCode(callisto, files) : []);
  const unclaimed = paths.filter((p) => !won.files.has(p) && !replaced.has(p) && !perLevel.has(p) && !included.has(p) && !shared.has(p) && !left.some((l) => l.file === p) && !isObjectTextFile(p) && !(code && SHARED_CODE.test(p) && /\.(asm|asar)$/i.test(p))).sort();
  return { ...head, status: 'ready', parts, code, samples: graphics.mwls, unclaimed, docs, callisto, notes };
}

// every file to its best claim: lowest rank, then the adapter first in DETECT_ORDER, a part before a
// file going with one; a file going with a part only when that part's main file went to it
function resolveClaims(d: Detection): { files: Set<string>; parts: PreviewPart[] } {
  type Ranked = FileClaim & { by: number; seq: number };
  const byFile = new Map<string, Ranked[]>();
  let seq = 0;
  DETECT_ORDER.forEach((k, by) => {
    for (const c of partAdapter(k).claims(d)) byFile.set(c.file, [...(byFile.get(c.file) ?? []), { ...c, by, seq: seq++ }]);
  });
  for (const cs of byFile.values()) cs.sort((a, b) => a.rank - b.rank || a.by - b.by || Number(!a.part) - Number(!b.part));
  const won = new Map<string, Ranked | null>();
  const winner = (f: string): Ranked | null => {
    if (won.has(f)) return won.get(f)!;
    won.set(f, null); // (while deciding: a file going with itself goes nowhere)
    const w = byFile.get(f)?.find((c) => {
      if (c.of === undefined) return true;
      const main = winner(c.of);
      return !!main?.part && main.by === c.by;
    }) ?? null;
    won.set(f, w);
    return w;
  };
  for (const f of byFile.keys()) winner(f);
  const all = [...won.values()].filter((c): c is Ranked => !!c);
  return { files: new Set(all.map((c) => c.file)), parts: all.filter((c) => c.part).sort((a, b) => a.seq - b.seq).map((c) => c.part!) };
}

// "3 files (2 .txt, 1 .png)"
function describe(paths: string[]): string {
  const ext = new Map<string, number>();
  for (const p of paths) { const e = /\.[^./]+$/.exec(p)?.[0].toLowerCase() ?? 'without extension'; ext.set(e, (ext.get(e) ?? 0) + 1); }
  return `${plural(paths.length, 'file')} (${[...ext].map(([e, n]) => `${n} ${e}`).join(', ')})`;
}

// ---------- installing ----------

// the suggestion: its folders, and a list.txt line for each resource file (number from the docs, else
// `level` for level code, game mode 14, overworld map 0)
export function defaultAssignment(p: ManualPreview, level: number): ManualAssignment {
  const rules = new Map(p.suggestion.rules);
  const calls = suggestCalls(p.files, placed(p.files.keys(), rules), { level, gamemode: 0x14, overworld: 0 }).map(({ file, ctx, num }) => ({ file, ctx, num }));
  return { rules, calls };
}

// sample: the sample level to put in place of the current one (a level edit, not saved yet); samples: the
// levels sample levels were written as (InstallOptions.samples)
export interface InstallResult extends ApplyResult { pkg: Package | null; sample?: SampleLevel; samples?: number[] }

// the sample level `file` as level `into` – the current one, or (`own`) the level of its own number with
// its screen exits and graphics slots – with the package's parts where they landed: Map16 tiles by the plan
// (a whole-ROM .map16's too), custom sprites when certain (one level sprite of that type in the package and
// one number of it in the level, or a PIXI list.txt of the package naming the number); its background with
// the package's BG Map16 tiles, its own colors and animations. The current level's slots are the level
// setup's.
function placeSample(rom: Rom, ctx: InstallContext, file: string, into: Level, own: boolean): SampleLevel {
  const { preview, opt } = ctx;
  const d = preview.files.get(file)!;
  const m = ctx.plan.map16;
  const from = m ? map16Targets(m.data, m.from) : [], to = m ? map16Targets(m.data, m.at) : [];
  const sprites = ctx.sprites?.sprites ?? [];
  const kindOf = (num: number) => (num < 0xc0 ? 'sprites' : num < 0xd0 ? 'shooters' : 'generators');
  const sec = mwlSections(d);
  const used = parseSprites(sec.sprites, 0, false, spriteSizes(rom)).sprites.filter((q) => q.extra & 2);
  const listed = new Map([...pixiListed(preview)].map(([f, num]) => [num, f]));
  const sample = sampleLevel(rom, d, into, {
    tile: (t) => { const i = from.indexOf(t); return i >= 0 ? to[i] : ctx.plan.romMap16?.fg.get(t) ?? null; },
    sprite: (num) => {
      const file = listed.get(num);
      const byList = file ? sprites.find((x) => x.file === file) : undefined;
      if (byList) return byList.num;
      const k = kindOf(num), mine = sprites.filter((x) => x.kind === k);
      return mine.length === 1 && new Set(used.filter((q) => kindOf(q.num) === k).map((q) => q.num)).size === 1 ? mine[0].num : null;
    },
  }, own);
  // the background: the BG tilemap, BG Map16 tiles of the package moved along (a whole-ROM .map16's where
  // they went, else the level file's .map16 as a level import places it)
  const mwl = parseMwl(d);
  const rm = ctx.plan.romMap16;
  if (mwl.bg && !sample.level.layer2Objects) {
    if (rm) sample.level.bg = mwl.bg.map((t) => rm.bg.get(t) ?? t);
    else try {
      const files = new Map([...preview.files].filter(([f]) => f === file || !/\.mwl$/i.test(f)));
      const bp = planBgPack(rom, preview.name, files, opt.blank);
      const r = allOrNothing(rom, () => applyBgPack(rom, sample.level, files, bp, { bg: true, fg: false, layer3: false, palettes: bp.palettes.map(() => false), cgram: opt.cgram ?? null, blank: opt.blank }));
      if (r.ok) sample.level.bg = r.bg; else sample.notes.push(`Background not taken over: ${r.errors.join(' ')}`);
    } catch (e) { sample.notes.push(`Background not taken over: ${e instanceof Error ? e.message : e}`); }
  }
  const n = into.number;
  if (own) for (const { slot, num } of sampleSlots(rom, n, sample.level.header, mwl, ctx.plan.gfx, sample.notes)) assignSlot(rom, n, slot, num);
  if (sample.palette || own) setCustomPalette(rom, n, sample.palette);
  // its ExAnimation in place of the level's (the level setup's slots of the package included), its frames
  // copied into the level's Anim graphic
  if (sample.exanim) {
    const slots = [...sample.exanim.slots];
    const f = levelFrames(rom, n, slots.map(([, e]) => e), ctx.plan.frames, opt.wram);
    sample.notes.push(...f.notes);
    sample.exanim.slots = new Map(slots.flatMap(([k], i) => f.slots[i] ? [[k, f.slots[i]!] as const] : []));
    sample.exanim.altFile = f.file;
  }
  writeLevelList(rom, n, sample.exanim);
  if (sample.exanim || levelSettings(rom, n)) setLevelSettings(rom, n, sample.exanimSettings);
  if (own) placeEntrances(rom, sample, sec.entrances);
  // its messages: in a Callisto project's overworld, the translevel of the level it was exported from
  const ow = preview.callisto?.overworld;
  if (ow) placeSampleMessages(rom, { file: ow, bps: preview.files.get(ow)! }, sec.number, n, sample.notes);
  return sample;
}

// the level file's secondary entrances into a sample level at its own number: at their numbers where those
// are free (blank, no other level's exit using them) or lead into the level already, else at free ones with
// the level's exits into them following
function placeEntrances(rom: Rom, sample: SampleLevel, entrances: MwlSections['entrances']): void {
  const lv = sample.level, n = lv.number;
  for (const { idx, bytes: [b, c, d, e, f] } of entrances) {
    const graph = new ExitGraph(rom, lv);
    const othersUse = graph.usersOfEntrance(idx).some((x) => x.from !== n);
    const at = readSecondaryEntrance(rom, idx).destLevel === n && !isBlank(rom, idx) && !isOverworldExit(rom, idx) ? idx
      : isBlank(rom, idx) && !othersUse ? idx : graph.freeEntrance();
    if (at === null) { sample.notes.push(`Its secondary entrance ${hx(idx)} not taken over: ${NO_FREE_ENTRANCE}`); continue; }
    writeSecondaryEntrance(rom, at, decodeSecondaryEntrance([n & 0xff, b, c, (d & ~SEC_LEVEL_HI) | (n & 0x100 ? SEC_LEVEL_HI : 0), e, f]));
    if (at === idx) continue;
    for (const x of lv.exits) if (x.secondary && exitIndex(n, x) === idx) x.dest = at;
    sample.notes.push(`Its secondary entrance ${hx(idx)} is ${hx(at)} here (${hx(idx)} is used)`);
  }
}

// the preview with the links between its parts set in its files before planning: code playing a sound
// effect of the package that gets another number than the author's has its define set to that number
// (the package's parts read anew from those files); with the sound effects' numbers. A string: it failed.
function linkedPreview(rom: Rom, preview: ReadyPreview): { preview: ReadyPreview; sfx: SfxPlan } | string {
  const sfx = planSfx(rom, preview);
  const files = withDefines(preview.files, sfxDefines(sfx));
  if (files === preview.files) return { preview, sfx };
  const again = inspectFiles(preview.fileName, files);
  return again.status === 'ready' ? { preview: again, sfx } : `The package with its sound effects' numbers set: ${again.status === 'failed' ? again.reason : again.status}`;
}

const failed = (errors: string[], warnings: string[] = [], prints: string[] = []): InstallResult => ({ ok: false, errors, warnings, prints, pkg: null });

// applies every part and records the package; ok false when it failed (run it in an edit session,
// romedit.ts, which puts the ROM back); the level setup and the sample levels after the recording: level
// edits, not the package's (ADR 0002), in the same edit session (one undo)
export async function installPackage(rom: Rom, preview: ReadyPreview | ManualPreview, opt: InstallOptions): Promise<InstallResult> {
  const warnings: string[] = [];
  const prints: string[] = [];
  let sample: SampleLevel | undefined;
  const samples: number[] = [];
  try {
    const archive = zipSync(Object.fromEntries(preview.files), { level: 9 });
    // Lunar Magic's object names and tooltips: kept with the package, over those of packages installed before
    const objectText = uploadObjectText(preview.files);
    const target = { name: preview.name, fileName: preview.fileName, archive, objectText };
    const textNotes = objectText ? objectTextNotes(rom, preview.name, objectText) : [];
    let rec;
    let ctx: InstallContext | null = null;
    if (preview.status === 'manual') {
      const a = opt.assignment ?? defaultAssignment(preview, opt.level ?? 0x105);
      rec = recordPackageChange(rom, target, (claim) => applyAssignment(rom, preview.files, a, claim));
    } else {
      const linked = linkedPreview(rom, preview);
      if (typeof linked === 'string') return failed([linked]);
      const parts = planInstall(rom, linked.preview, opt, linked.sfx);
      ctx = parts;
      rec = await recordPackageChangeAsync(rom, target, (claim) => applyParts(rom, parts, claim));
    }
    // sprites the package's PIXI list gives only per-level numbers: named as left out
    if (preview.status === 'ready') warnings.push(...perLevelLeftOut(preview).values());
    warnings.push(...rec.result.warnings);
    prints.push(...rec.result.prints);
    if (!rec.result.ok) return failed(rec.result.errors, warnings, prints);
    if (!rec.pkg) return failed(['Nothing changed – everything in the package is already in the ROM.']);
    if (ctx) {
      // the sample level needs the package's ExGFX in its slots: the level setup comes with it
      if (opt.level !== null && (opt.setup !== false || opt.sample) && (ctx.plan.gfx.some((g) => g.slot) || ctx.plan.palettes.length || ctx.plan.exanim.length)) {
        const s = applyLevelSetup(rom, opt.level, ctx.plan, { cgram: opt.cgram ?? null, wram: opt.wram });
        warnings.push(...s.warnings);
        prints.push(...s.prints);
      }
      if (opt.sample && ctx.preview.samples.length === 1) {
        sample = placeSample(rom, ctx, ctx.preview.samples[0], opt.sample, false);
        warnings.push(...sample.notes);
      }
      // sample levels at their own numbers: written (level edits of levels not open)
      for (const f of opt.samples ?? []) {
        const at = ctx.plan.samples.find((x) => x.file === f && !x.left)?.level ?? null;
        if (at === null) { warnings.push(`${f}: not offered as a sample level – left out`); continue; }
        // (one that cannot be taken over leaves the others and the package)
        let s: SampleLevel;
        try {
          s = allOrNothing(rom, () => { const x = placeSample(rom, ctx, f, loadLevel(rom, at), true); saveLevel(rom, x.level); return x; });
        } catch (e) { warnings.push(`Level ${hx(at)}: the sample level ${f.split('/').pop()} not taken over – ${e instanceof Error ? e.message : e}`); continue; }
        warnings.push(...s.notes.map((t) => `Level ${hx(at)}: ${t}`));
        prints.push(`Level ${hx(at)}: the sample level ${f.split('/').pop()}`);
        samples.push(at);
      }
    }
    warnings.push(...textNotes);
    return { ok: true, errors: [], warnings, prints, pkg: rec.pkg, sample, ...(samples.length ? { samples } : {}) };
  } catch (e) {
    return failed([e instanceof Error ? e.message : String(e)], warnings, prints);
  }
}

// applies the patch of an installed package (registry entry `entryId`) anew with other settings; the
// patch's new id goes into the package's record (`rec`; null: none). Run it in an edit session.
export function reapplyPackagePatch(rom: Rom, entryId: string, upload: UploadCode, fileName: string, main: string, values: Record<string, string>, rec: Package | null): ApplyResult {
  return recordedIn(rom, rec, () => reapplyPatch(rom, entryId, patchSource(upload, fileName, main, values)));
}

// writes a file imported for an installed package (`into`; null: for none; the graphics tab's import):
// what it adds (an ExGFX number) goes into the package's record; `write` throws when it fails. Run it in
// an edit session. Returns what `write` did.
export function importForPackage<T>(rom: Rom, into: Package | null, write: () => T): T {
  let value!: T;
  recordedIn(rom, into, () => { value = write(); return { ok: true }; });
  return value;
}

// runs `change`, recorded into the package when there is one
function recordedIn<R extends { ok: boolean }>(rom: Rom, pkg: Package | null, change: () => R): R {
  return pkg ? recordPackageChange(rom, pkg, change).result : change();
}

// ---------- files and manuals ----------

// the files of an installed package (kept with its record in the editor data), null if there are none
export function packageFiles(rom: Rom, pkg: Package): Map<string, Uint8Array> | null {
  const a = packageArchive(rom, pkg);
  return a ? new Map(Object.entries(unzipSync(a))) : null;
}

// the installed packages that brought files of a tool project and have a manual, with their files: the
// manual comes and goes with its package (and its undo)
export function packageManuals(rom: Rom, tool: ToolKind): { pkg: Package; files: Map<string, Uint8Array> }[] {
  const out: { pkg: Package; files: Map<string, Uint8Array> }[] = [];
  for (const pkg of listPackages(rom)) {
    if (!pkg[tool].files.length) continue;
    const files = packageFiles(rom, pkg);
    if (files && packageDocs(files).length) out.push({ pkg, files });
  }
  return out;
}
