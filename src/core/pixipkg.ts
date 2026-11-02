// The sprites of a package (SMWCentral): sprites with their cfg/json, misc sprites (.asm in a folder
// named after their type) and shared routines. Each sprite gets the next free number of its type;
// defines in any file of the package that name one of its sprites (by its file name in the comment, or
// a misc type in the define's name, e.g. !bounce_sprite of a block spawning it) are linked to its
// number – the sprites' own files here, other parts' (blocks) by the caller.

import type { Rom } from './rom.ts';
import { scanDefines, withDefines, type FileDefines, type Upload } from './patchpkg.ts';
import { FOLDER, MISC_KINDS, numberRange, sharesNumbers, assignSprite, loadPixiProject, savePixiProject, parseCfg, parseJsonCfg, type PixiEntry, type PixiProject } from './pixi.ts';
import type { ApplyResult } from './patchapply.ts';
import type { SpriteFolder } from './pixirt.ts';

export interface PixiPlanSprite { kind: SpriteFolder; file: string; num: number; name: string }
export interface PixiLink { file: string; define: string; sprite: number } // define in a file set to sprites[sprite]'s number
export interface PixiPlan { sprites: PixiPlanSprite[]; links: PixiLink[]; routines: string[] }

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

// the sprites and routines of an upload, without numbers yet (-1)
export function pixiParts(upload: Upload): Omit<PixiPlan, 'links'> {
  const sprites: PixiPlanSprite[] = [];
  const used = new Set<string>(); // asm files belonging to a cfg/json
  for (const [f, data] of upload.files) {
    if (!/\.(json|cfg)$/i.test(f)) continue;
    if (/\.json$/i.test(f) && !/"(ActLike|AsmFile|\$1656|Type)"/i.test(dec.decode(data))) continue; // (another tool's json, e.g. BOWSIE's tooltips)
    try {
      const c = /\.json$/i.test(f) ? parseJsonCfg(dec.decode(data), f) : parseCfg(dec.decode(data), f);
      if (c.asm) used.add(c.asm);
      const k = folderKind(f);
      sprites.push({ kind: k === 'shooters' || k === 'generators' ? k : 'sprites', file: f, num: -1, name: c.names[0]?.name ?? base(f) });
    } catch { /* not a sprite cfg */ }
  }
  const routines: string[] = [];
  for (const [f, data] of upload.files) {
    if (!/\.asm$/i.test(f) || used.has(f)) continue;
    if (/(^|\/)routines\//i.test(f)) { routines.push(f); continue; }
    if (/(^|\/)_header\.asm$/i.test(f)) continue;
    const text = dec.decode(data);
    if (!/print\s+"MAIN ?"\s*,\s*pc/i.test(text)) continue; // an include of another file
    const k = folderKind(f);
    sprites.push({ kind: k && MISC_KINDS.includes(k) ? k : k ?? 'sprites', file: f, num: -1, name: base(f).replace(/\.asm$/i, '') });
  }
  return { sprites, routines };
}

// numbers for the sprites of an upload (those `keep` takes: the sprite parts) and the defines naming them;
// `listed`: the numbers the package's PIXI list gives them (by file), taken when free
export function planPixiUpload(rom: Rom, upload: Upload, keep: (file: string) => boolean = () => true, listed = new Map<string, number>()): PixiPlan {
  const proj = loadPixiProject(rom) ?? { files: new Map(), list: [] };
  const parts = pixiParts(upload);
  const sprites = parts.sprites.filter((s) => keep(s.file)), routines = parts.routines;
  // numbers: a sprite file already in the project keeps its number, the others get the list's when free,
  // else the next free one
  const taken = (s: PixiPlanSprite) => new Set([...proj.list.filter((e) => sharesNumbers(e.kind, s.kind)).map((e) => e.num),
    ...sprites.filter((o) => o !== s && o.num >= 0 && sharesNumbers(o.kind, s.kind)).map((o) => o.num)]);
  for (const s of sprites) {
    const have = proj.list.find((e) => e.kind === s.kind && e.file === destOf(upload, s));
    if (have) s.num = have.num;
  }
  for (const s of sprites) {
    const [lo, hi] = numberRange(s.kind), want = listed.get(s.file);
    if (s.num >= 0 || want === undefined || want < lo || want > hi || taken(s).has(want)) continue;
    s.num = want;
  }
  for (const s of sprites) {
    if (s.num >= 0) continue;
    const [lo, hi] = numberRange(s.kind), t = taken(s);
    let n = lo;
    while (t.has(n) && n < hi) n++;
    s.num = n;
  }
  // defines naming a sprite of the package
  const links: PixiLink[] = [];
  for (const [f, data] of upload.files) {
    if (!/\.asm$/i.test(f)) continue;
    for (const d of scanDefines(dec.decode(data))) {
      const byFile = sprites.findIndex((s) => d.comment.toLowerCase().includes(base(s.file).toLowerCase()));
      let i = byFile;
      // a sprite define holding the number the list gives a sprite (a block spawning it): it follows the sprite
      if (i < 0 && /sprite|num|number/i.test(d.name + ' ' + d.comment)) {
        const v = defineNumber(d.value);
        const byNum = v === null ? [] : sprites.map((s, j) => [s, j] as const).filter(([s]) => listed.get(s.file) === v);
        if (byNum.length === 1) i = byNum[0][1];
      }
      if (i < 0) {
        const kinds = MISC_KINDS.filter((k) => d.name.toLowerCase().replace(/_/g, '').includes(k === 'spinningcoin' ? 'coin' : k === 'minorextended' ? 'minor' : k));
        const cand = sprites.map((s, j) => [s, j] as const).filter(([s]) => kinds.includes(s.kind));
        if (cand.length === 1 && /sprite|num|number/i.test(d.name + ' ' + d.comment)) i = cand[0][1];
      }
      if (i >= 0 && sprites[i].file !== f) links.push({ file: f, define: d.name, sprite: i });
    }
  }
  return { sprites, links, routines };
}

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

// a define's value as a number ($hex or decimal), else null
function defineNumber(v: string): number | null {
  const m = /^\$([0-9a-f]{1,2})$/i.exec(v.trim()) ?? null;
  if (m) return parseInt(m[1], 16);
  return /^\d{1,3}$/.test(v.trim()) ? parseInt(v.trim(), 10) : null;
}

export function hexNum(n: number): string {
  return '$' + n.toString(16).toUpperCase().padStart(2, '0');
}

// adds the sprites to the ROM's PIXI project; `others`: files of the package's other parts (not taken
// along from a sprite's folder); claim: every project file it writes (pkgreg.ts)
export function applyPixiUpload(rom: Rom, upload: Upload, plan: PixiPlan, others: Set<string>, claim: (file: string) => void): ApplyResult {
  const proj: PixiProject = loadPixiProject(rom) ?? { files: new Map(), list: [] };
  // define values from the chosen numbers
  const files = withDefines(upload.files, linkedDefines(plan));
  const content = (f: string) => files.get(f)!;

  // the files of a sprite: those in its folder, except what belongs to a deeper folder of another one,
  // the other sprites' own files, the routines and the files of other parts
  const mains = new Set(plan.sprites.map((s) => s.file));
  const dirs = [...new Set([...mains].map(dirOf))];
  const filesOf = (main: string) => {
    const dir = dirOf(main);
    return [...upload.files.keys()].filter((f) => f.startsWith(dir) && (f === main || (!mains.has(f) && !others.has(f))) && !/(^|\/)routines\//i.test(f)
      && !dirs.some((d) => d.length > dir.length && d.startsWith(dir) && f.startsWith(d)));
  };
  for (const s of plan.sprites) {
    const dir = dirOf(s.file);
    const destDir = dirOf(FOLDER[s.kind] + relIn(s.file, s.kind));
    for (const f of filesOf(s.file)) { const to = destDir + f.slice(dir.length); proj.files.set(to, content(f)); claim(to); }
    const entry: PixiEntry = { kind: s.kind, num: s.num, file: FOLDER[s.kind] + relIn(s.file, s.kind) };
    proj.list = proj.list.filter((e) => !(e.kind === s.kind && e.file === entry.file)); // its file under one number
    assignSprite(proj, entry);
  }
  for (const f of plan.routines) { const to = f.slice(f.search(/routines\//i)); proj.files.set(to, content(f)); claim(to); }
  return savePixiProject(rom, proj);
}

// per file, the defines naming a sprite of the plan, set to its number
export function linkedDefines(plan: PixiPlan): FileDefines {
  const byFile: FileDefines = new Map();
  for (const l of plan.links) {
    const d = byFile.get(l.file) ?? {};
    d[l.define] = hexNum(plan.sprites[l.sprite].num);
    byFile.set(l.file, d);
  }
  return byFile;
}
