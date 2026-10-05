// Block packages as found on SMWCentral: GPS blocks with their list.txt, often a Lunar Magic .map16
// file with the tiles' graphics and an ExGFX file (e.g. "ExGFX80_BG2.bin" for the BG2 slot).
// planBlockPack() works out what goes where; applyBlockPack() does it in one step.

import { Rom } from './rom.ts';
import type { PatchPackage } from './patchpkg.ts';
import type { ApplyResult } from './patchapply.ts';
import { parseBlockList, loadBlockProject, saveBlockProject, type BlockAssign } from './blocks.ts';
import { parseMap16File, map16Targets, exgfxName, importGfxFile, type Map16File } from './map16file.ts';
import { setExtTileWords, setActsLike, EXT_FIRST } from './map16ext.ts';
import { levelGfx, setLevelGfx, levelExtGfx, setLevelExtGfx, GFX_SLOT_NAMES, EXT_GFX_SLOT_NAMES, extGfxAvailable } from './patches.ts';

export interface BlockPackPlan {
  blocks: BlockAssign[]; // file = path inside the package
  map16: { file: string; data: Map16File; at: number } | null;
  gfx: { file: string; num: number; slot: string | null }[];
  missing: string[]; // block files named in list.txt but not in the package
}

const dec = new TextDecoder();

export function planBlockPack(pkg: PatchPackage, listFile: string): BlockPackPlan {
  const dir = listFile.includes('/') ? listFile.slice(0, listFile.lastIndexOf('/') + 1) : '';
  const find = (name: string) => {
    const n = name.replace(/\\/g, '/');
    for (const c of [dir + n, dir + 'blocks/' + n]) if (pkg.files.has(c)) return c;
    return [...pkg.files.keys()].find((f) => f.toLowerCase().endsWith('/' + n.toLowerCase()) || f.toLowerCase() === n.toLowerCase()) ?? null;
  };
  const missing: string[] = [];
  const blocks: BlockAssign[] = [];
  for (const b of parseBlockList(dec.decode(pkg.files.get(listFile)!))) {
    const f = find(b.file.replace(/^blocks\//, ''));
    if (f) blocks.push({ ...b, file: f }); else missing.push(b.file.replace(/^blocks\//, ''));
  }
  const mf = [...pkg.files.keys()].find((f) => /\.map16$/i.test(f));
  const first = blocks.length ? Math.min(...blocks.map((b) => b.tile)) : EXT_FIRST;
  const map16 = mf ? { file: mf, data: parseMap16File(pkg.files.get(mf)!), at: first } : null;
  const gfx = [...pkg.files.keys()].filter((f) => /\.bin$/i.test(f) && /exgfx/i.test(f)).map((f) => {
    const n = exgfxName(f.split('/').pop()!);
    return { file: f, num: n.num ?? 0x80, slot: n.slot };
  });
  return { blocks, map16, gfx, missing };
}

export interface BlockPackOptions {
  blank: number[]; // tile words of an empty Map16 tile
  level: number | null; // level whose GFX slots get the package's ExGFX (by the slot in the file name)
  map16At?: number; // top-left tile for the .map16 tiles (default: the plan's)
}

export function applyBlockPack(rom: Rom, pkg: PatchPackage, plan: BlockPackPlan, opt: BlockPackOptions): ApplyResult & { notes: string[] } {
  const snapshot = rom.data.slice();
  const notes: string[] = [];
  const fail = (e: unknown): ApplyResult & { notes: string[] } => {
    rom.data = snapshot;
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)], warnings: [], prints: [], notes };
  };
  try {
    // 1. blocks
    const proj = loadBlockProject(rom) ?? { files: new Map(), list: [] };
    const tiles = new Set(plan.blocks.map((b) => b.tile));
    proj.list = proj.list.filter((b) => !tiles.has(b.tile));
    for (const b of plan.blocks) {
      const name = 'blocks/' + b.file.split('/').pop();
      proj.files.set(name, pkg.files.get(b.file)!);
      proj.list.push({ tile: b.tile, file: name, acts: b.acts });
    }
    for (const [f, c] of pkg.files) if (/(^|\/)routines\/[^/]+\.asm$/i.test(f)) proj.files.set(f.slice(f.search(/routines\//i)), c);
    const r = saveBlockProject(rom, proj, opt.blank);
    if (!r.ok) { rom.data = snapshot; return { ...r, notes }; }
    notes.push(`${plan.blocks.length} block(s) at ${plan.blocks.map((b) => b.tile.toString(16).toUpperCase()).join(', ')}`);
    // 2. Map16 graphics (and acts like where list.txt gives none)
    if (plan.map16) {
      const at = opt.map16At ?? plan.map16.at;
      const targets = map16Targets(plan.map16.data, at);
      let n = 0;
      targets.forEach((t, i) => {
        if (t < EXT_FIRST) return;
        setExtTileWords(rom, t, plan.map16!.data.tiles[i], opt.blank);
        const acts = plan.map16!.data.acts?.[i];
        if (acts !== undefined && !plan.blocks.some((b) => b.tile === t && b.acts !== undefined)) setActsLike(rom, t, acts, opt.blank);
        n++;
      });
      if (n < targets.length) notes.push(`${targets.length - n} Map16 tile(s) below 200 skipped`);
      notes.push(`Map16 graphics for ${n} tile(s) from ${at.toString(16).toUpperCase()}`);
    }
    // 3. ExGFX and the level's slot
    for (const g of plan.gfx) {
      const what = importGfxFile(rom, g.num, pkg.files.get(g.file)!);
      let where = '';
      if (opt.level !== null && g.slot) {
        const ext = EXT_GFX_SLOT_NAMES.indexOf(g.slot);
        const std = GFX_SLOT_NAMES.indexOf(g.slot);
        if (ext >= 0 && !extGfxAvailable(rom)) notes.push(`${g.slot} slot not available yet (VRAM patch missing) – the graphics are stored but not loaded yet`);
        else if (ext >= 0) { const s = levelExtGfx(rom, opt.level); s[ext] = g.num; setLevelExtGfx(rom, opt.level, s); }
        else if (std >= 0) { const s = levelGfx(rom, opt.level); s[std] = g.num; setLevelGfx(rom, opt.level, s); }
        if ((ext >= 0 && extGfxAvailable(rom)) || std >= 0) where = ` as ${g.slot} of level ${opt.level.toString(16).toUpperCase().padStart(3, '0')}`;
      }
      notes.push(`ExGFX ${g.num.toString(16).toUpperCase()} (${what})${where}`);
    }
    return { ...r, notes };
  } catch (e) { return fail(e); }
}
