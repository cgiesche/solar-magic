// A downloaded custom sprite package (SMWCentral): sprites with their cfg/json, misc sprites (.asm in a
// folder named after their type), possibly GPS blocks that use them (Aftertouch Shatter: a block spawning
// its bounce sprite) and shared routines. Each sprite gets the next free number of its type; defines
// that name a sprite of the package (by its file name in the comment, or a misc type in the define's
// name, e.g. !bounce_sprite) are set to its number.

import type { Rom } from './rom.ts';
import { scanDefines, rewriteDefines, type Upload } from './patchpkg.ts';
import { FOLDER, MISC_KINDS, numberRange, loadPixiProject, savePixiProject, parseCfg, parseJsonCfg, type PixiEntry, type PixiProject } from './pixi.ts';
import { loadBlockProject, saveBlockProject, type BlockProject } from './blocks.ts';
import { setExtTileWords, EXT_FIRST, EXT_TILES } from './map16ext.ts';
import type { ApplyResult } from './patchapply.ts';
import type { SpriteFolder } from './pixirt.ts';

export interface PixiPlanSprite { kind: SpriteFolder; file: string; num: number; name: string }
export interface PixiPlanBlock { file: string; tile: number; acts: number }
export interface PixiLink { file: string; define: string; sprite: number } // define in a file set to sprites[sprite]'s number
export interface PixiPlan { sprites: PixiPlanSprite[]; blocks: PixiPlanBlock[]; links: PixiLink[]; routines: string[] }

const dec = new TextDecoder();
const enc = new TextEncoder();
const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

// the type a file's folder names: …/shooters/x.json, …/misc_sprites/bounce/x.asm, …/cluster/x.asm
function folderKind(f: string): SpriteFolder | null {
  const parts = f.toLowerCase().split('/').slice(0, -1);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i].replace(/[^a-z]/g, '');
    if (p === 'shooters' || p === 'shooter') return 'shooters';
    if (p === 'generators' || p === 'generator') return 'generators';
    if (p === 'sprites' || p === 'sprite') return 'sprites';
    for (const k of MISC_KINDS) if (p === k || p === k + 's' || (k === 'minorextended' && p === 'minorextendedsprites')) return k;
  }
  return null;
}
const isBlock = (text: string) => {
  const first = text.split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim())
    .find((l) => l && !/^(print|!|incsrc|incbin|if|endif|else|macro|endmacro|%)/i.test(l) && !/^[A-Za-z_.][A-Za-z0-9_.]*:$/.test(l));
  return !!first && /^db\s+\$(42|37)\b/i.test(first);
};

export function planPixiUpload(rom: Rom, upload: Upload): PixiPlan {
  const proj = loadPixiProject(rom) ?? { files: new Map(), list: [] };
  const sprites: PixiPlanSprite[] = [];
  const used = new Set<string>(); // asm files belonging to a cfg/json
  for (const [f, data] of upload.files) {
    if (!/\.(json|cfg)$/i.test(f)) continue;
    try {
      const c = /\.json$/i.test(f) ? parseJsonCfg(dec.decode(data), f) : parseCfg(dec.decode(data), f);
      if (c.asm) used.add(c.asm);
      const k = folderKind(f);
      sprites.push({ kind: k === 'shooters' || k === 'generators' ? k : 'sprites', file: f, num: -1, name: c.names[0]?.name ?? base(f) });
    } catch { /* not a sprite cfg */ }
  }
  const blocks: PixiPlanBlock[] = [];
  const routines: string[] = [];
  for (const [f, data] of upload.files) {
    if (!/\.asm$/i.test(f) || used.has(f)) continue;
    if (/(^|\/)routines\//i.test(f)) { routines.push(f); continue; }
    if (/(^|\/)_header\.asm$/i.test(f)) continue;
    const text = dec.decode(data);
    if (isBlock(text)) {
      const al = /act(?:s)?\s*like[:\s]*\$?([0-9a-f]{1,3})\b/i.exec(text);
      blocks.push({ file: f, tile: -1, acts: al ? parseInt(al[1], 16) : 0x130 });
      continue;
    }
    if (!/print\s+"MAIN ?"\s*,\s*pc/i.test(text)) continue; // an include of another file
    const k = folderKind(f);
    sprites.push({ kind: k && MISC_KINDS.includes(k) ? k : k ?? 'sprites', file: f, num: -1, name: base(f).replace(/\.asm$/i, '') });
  }
  // numbers: a sprite file already in the project keeps its number, the others get the next free one
  for (const s of sprites) {
    const dest = destOf(upload, s);
    const have = proj.list.find((e) => e.kind === s.kind && e.file === dest);
    if (have) { s.num = have.num; continue; }
    const [lo, hi] = numberRange(s.kind);
    const taken = new Set([...proj.list.filter((e) => e.kind === s.kind || (isLevelKind(e.kind) && isLevelKind(s.kind))).map((e) => e.num),
      ...sprites.filter((o) => o !== s && o.num >= 0 && (o.kind === s.kind || (isLevelKind(o.kind) && isLevelKind(s.kind)))).map((o) => o.num)]);
    let n = lo;
    while (taken.has(n) && n < hi) n++;
    s.num = n;
  }
  // blocks: next free Map16 tiles from 200
  const bproj = loadBlockProject(rom);
  const tiles = new Set((bproj?.list ?? []).map((b) => b.tile));
  let t = EXT_FIRST;
  for (const b of blocks) { while (tiles.has(t) && t < EXT_TILES - 1) t++; b.tile = t; tiles.add(t++); }
  // defines naming a sprite of the package
  const links: PixiLink[] = [];
  for (const [f, data] of upload.files) {
    if (!/\.asm$/i.test(f)) continue;
    for (const d of scanDefines(dec.decode(data))) {
      const byFile = sprites.findIndex((s) => d.comment.toLowerCase().includes(base(s.file).toLowerCase()));
      let i = byFile;
      if (i < 0) {
        const kinds = MISC_KINDS.filter((k) => d.name.toLowerCase().replace(/_/g, '').includes(k === 'spinningcoin' ? 'coin' : k === 'minorextended' ? 'minor' : k));
        const cand = sprites.map((s, j) => [s, j] as const).filter(([s]) => kinds.includes(s.kind));
        if (cand.length === 1 && /sprite|num|number/i.test(d.name + ' ' + d.comment)) i = cand[0][1];
      }
      if (i >= 0 && sprites[i].file !== f) links.push({ file: f, define: d.name, sprite: i });
    }
  }
  return { sprites, blocks, links, routines };
}
const isLevelKind = (k: SpriteFolder) => k === 'sprites' || k === 'shooters' || k === 'generators';

// where a sprite's file goes in the project: below the folder of its type, with the path inside the
// package's folder for that type (or next to the file) kept
function destOf(upload: Upload, s: PixiPlanSprite): string {
  return FOLDER[s.kind] + relIn(s.file, s.kind);
}
function relIn(f: string, kind: SpriteFolder): string {
  const parts = f.split('/');
  for (let i = parts.length - 2; i >= 0; i--) if (folderKind(parts.slice(0, i + 1).join('/') + '/x') === kind) return parts.slice(i + 1).join('/');
  return base(f);
}

export function hexNum(n: number): string {
  return '$' + n.toString(16).toUpperCase().padStart(2, '0');
}

// adds the package to the ROM's PIXI project (and its blocks to the GPS project); blank: tile words for new Map16 tiles,
// gfxOf: tile words to copy for a block's new tile (from its acts like)
export function applyPixiUpload(rom: Rom, upload: Upload, plan: PixiPlan, blank: number[], gfxOf: (acts: number) => number[]): ApplyResult {
  const snapshot = rom.snapshot();
  const r = addUpload(rom, upload, plan, blank, gfxOf);
  if (!r.ok) rom.restore(snapshot); // all or nothing
  return r;
}

function addUpload(rom: Rom, upload: Upload, plan: PixiPlan, blank: number[], gfxOf: (acts: number) => number[]): ApplyResult {
  const proj: PixiProject = loadPixiProject(rom) ?? { files: new Map(), list: [] };
  // define values from the chosen numbers
  const texts = new Map<string, string>();
  const textOf = (f: string) => texts.get(f) ?? dec.decode(upload.files.get(f)!);
  const byFile = new Map<string, Record<string, string>>();
  for (const l of plan.links) {
    const d = byFile.get(l.file) ?? {};
    d[l.define] = hexNum(plan.sprites[l.sprite].num);
    byFile.set(l.file, d);
  }
  for (const [f, d] of byFile) texts.set(f, rewriteDefines(textOf(f), d).text);
  const content = (f: string) => (texts.has(f) ? enc.encode(texts.get(f)!) : upload.files.get(f)!);

  // the files of a sprite or block: those in its folder, except what belongs to a deeper folder of another
  // one, the other sprites' and blocks' own files and the routines
  const mains = new Set([...plan.blocks.map((b) => b.file), ...plan.sprites.map((s) => s.file)]);
  const dirs = [...new Set([...mains].map(dirOf))];
  const filesOf = (main: string) => {
    const dir = dirOf(main);
    return [...upload.files.keys()].filter((f) => f.startsWith(dir) && (f === main || !mains.has(f)) && !/(^|\/)routines\//i.test(f)
      && !dirs.some((d) => d.length > dir.length && d.startsWith(dir) && f.startsWith(d)));
  };
  for (const s of plan.sprites) {
    const dir = dirOf(s.file);
    const destDir = dirOf(FOLDER[s.kind] + relIn(s.file, s.kind));
    for (const f of filesOf(s.file)) proj.files.set(destDir + f.slice(dir.length), content(f));
    const entry: PixiEntry = { kind: s.kind, num: s.num, file: FOLDER[s.kind] + relIn(s.file, s.kind) };
    proj.list = proj.list.filter((e) => !(e.num === s.num && (e.kind === s.kind || (isLevelKind(e.kind) && isLevelKind(s.kind)))) && !(e.kind === s.kind && e.file === entry.file));
    proj.list.push(entry);
  }
  for (const f of plan.routines) proj.files.set(f.slice(f.search(/routines\//i)), content(f));
  const r = savePixiProject(rom, proj);
  if (!r.ok || !plan.blocks.length) return r;

  const bproj: BlockProject = loadBlockProject(rom) ?? { files: new Map(), list: [] };
  for (const b of plan.blocks) {
    const dir = dirOf(b.file);
    for (const f of filesOf(b.file)) if (/\.(asm|bin)$/i.test(f)) bproj.files.set('blocks/' + f.slice(dir.length), content(f));
    bproj.list = bproj.list.filter((x) => x.tile !== b.tile);
    bproj.list.push({ tile: b.tile, file: 'blocks/' + base(b.file), acts: b.acts });
  }
  const rb = saveBlockProject(rom, bproj, blank);
  if (!rb.ok) return { ...rb, errors: ['Custom Blocks: ' + rb.errors.join(' ')] };
  for (const b of plan.blocks) if (b.tile >= EXT_FIRST) setExtTileWords(rom, b.tile, gfxOf(b.acts), blank);
  return { ...r, warnings: [...r.warnings, ...rb.warnings], prints: [...r.prints, ...rb.prints] };
}
