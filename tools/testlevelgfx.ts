// Level graphics placement (core/levelgfx.ts): a package's level setup and a level import place the same
// graphics the same way – Map16 tiles, ExGFX numbers and slots, ExAnimation with its frames, colors; both
// count the block project's tiles as taken and both leave the colors alone (with a warning) when the
// level's are not known. A level import is a level file without code or songs, on every path.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { map16Source } from '../src/core/render.ts';
import { uploadFiles } from '../src/core/patchpkg.ts';
import { inspectFiles, installPackage, type ReadyPreview } from '../src/core/packages.ts';
import { planBgPack, importLevelFile, isLevelImport } from '../src/core/bgpack.ts';
import { levelColors } from '../src/core/levelgfx.ts';
import { loadLevel } from '../src/core/level.ts';
import { readLevelList, readAltFile } from '../src/core/exanim.ts';
import { levelGfx, levelExtGfx, customPalette, gfxEntry } from '../src/core/patches.ts';
import { extTileWords, actsLike, setExtTileWords, setActsLike, DEFAULT_ACTS } from '../src/core/map16ext.ts';
import { loadBlockProject } from '../src/core/blocks.ts';
import { installVramPatch } from '../src/core/vrampatch.ts';
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage();
await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined) =>
  !!a && !!b && a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);
const LV = 0x105;

// On-Off Blocks, its level file's BG2 slot (the slot its Map16 tiles draw from) on an ExGFX of the upload
const all = uploadFiles('On-Off Block.zip', new Uint8Array(readFileSync('test/fixtures/On-Off Block.zip')));
const mwl = all.get('SampleLevel.mwl')!.slice();
const list = mwl[0x40 + 7 * 8] | (mwl[0x41 + 7 * 8] << 8) | (mwl[0x42 + 7 * 8] << 16);
mwl[list + 3 * 2] = 0xa2; mwl[list + 3 * 2 + 1] = 0x08; // LM_SLOTS[3] = BG2 → ExGFX 8A2
const exgfx = Uint8Array.from({ length: 0x1000 }, (_, i) => (i * 7) & 0xff);
const pkgFiles = new Map([...all, ['SampleLevel.mwl', mwl], ['ExGraphics/ExGFX8A2.bin', exgfx]]);
const importFiles = new Map([...pkgFiles].filter(([f]) => !/\.asm$/i.test(f)));

check(!isLevelImport(pkgFiles) && inspectFiles('On-Off Block.zip', pkgFiles).status === 'ready', 'a level file with code: a package (its sample level), not a level import');
check(isLevelImport(importFiles) && inspectFiles('On-Off Block.zip', importFiles).status === 'level-import', 'the same without code: a level import');
check(!isLevelImport(new Map([['a.asm', new Uint8Array()]])), 'no level file: no level import');

// a fresh ROM with the VRAM patch (slot BG2), its level 105 loaded
const fresh = () => {
  const rom = new Rom(EDITOR_IMAGE.slice());
  check(installVramPatch(rom).ok, 'VRAM patch installed');
  const e = new LevelEmulator(rom); e.boot();
  const l = e.load(LV);
  return { rom, l, blank: map16Source(rom, l).fg(0x025), tileWords: (t: number) => map16Source(rom, l).fg(t) };
};

// what a placement left in the ROM
const result = (rom: Rom, tiles: number[]) => ({
  words: tiles.map((t) => extTileWords(rom, t)),
  std: levelGfx(rom, LV), ext: levelExtGfx(rom, LV),
  stored: (n: number) => { const e = gfxEntry(rom, n); return e?.raw ? rom.bytes(e.addr, 0x1000) : null; },
  list: [...(readLevelList(rom, LV)?.slots ?? [])].map(([k, e]) => `${k}:${JSON.stringify(e)}`).join(' '),
  alt: readAltFile(rom, readLevelList(rom, LV)?.altFile ?? 0),
  pal: customPalette(rom, LV) ? rom.bytes(customPalette(rom, LV), 512) : null,
});

// the package path: installed with the level setup
const p = fresh();
const pkg = await installPackage(p.rom, inspectFiles('On-Off Block.zip', pkgFiles) as ReadyPreview, { level: LV, blank: p.blank, tileWords: p.tileWords, cgram: levelColors(p.l), wram: p.l.wram });
const tiles = pkg.pkg?.block.tiles ?? [];
check(pkg.ok && tiles.join() === [0x508, 0x509].join(), `package: Map16 tiles on 508/509 (${[...pkg.errors, ...pkg.warnings].join(' | ')})`);
// the level import path: the foreground only (the package's level setup takes no background)
const i = fresh();
const plan = planBgPack(i.rom, 'On-Off', importFiles, i.blank);
const imp = importLevelFile(i.rom, loadLevel(i.rom, LV), importFiles, plan, { bg: false, cgram: levelColors(i.l), wram: i.l.wram, blank: i.blank });
check(imp.ok && plan.fgAt === 0x508, `level import: Map16 tiles from 508, as the package (${plan.fgAt.toString(16)}; ${[...imp.errors, ...imp.notes].join(' | ')})`);

const a = result(p.rom, tiles), b = result(i.rom, [plan.fgAt, plan.fgAt + 1]);
check(a.words.every((w, k) => same(w, b.words[k])), 'same Map16 tile graphics');
check(same(a.std, b.std) && same(a.ext, b.ext) && a.ext[0] === 0x8a2 && same(a.stored(0x8a2), exgfx) && same(b.stored(0x8a2), exgfx),
  `same graphics slots: BG2 = ExGFX ${a.ext[0]?.toString(16)} (8A2 kept), the same file`);
check(!!a.list && a.list === b.list && same(a.alt, b.alt), 'same ExAnimation slots, same frames in the Anim graphic');
check(!!a.pal && same(a.pal, b.pal), 'same colors');

// a free FG tile: a tile of the block project is taken on the level import path too, even with blank
// graphics and acts like
{
  const { rom, blank } = p;
  for (const t of tiles) { setExtTileWords(rom, t, blank); setActsLike(rom, t, DEFAULT_ACTS); }
  check(tiles.every((t) => actsLike(rom, t) === DEFAULT_ACTS) && (loadBlockProject(rom)?.list ?? []).some((x) => x.tile === 0x508), 'blocks on 508/509 with an empty tile\'s graphics');
  const again = planBgPack(rom, 'On-Off', importFiles, blank);
  check(again.fgAt !== 0x508 && again.fgAt !== 0x509 && again.fgAt !== 0x507, `level import: the block tiles are taken (FG tiles from ${again.fgAt.toString(16)})`);
}

// colors not known: neither path makes up a palette, both warn
{
  const q = fresh();
  const r = await installPackage(q.rom, inspectFiles('On-Off Block.zip', pkgFiles) as ReadyPreview, { level: LV, blank: q.blank, tileWords: q.tileWords });
  check(r.ok && !customPalette(q.rom, LV) && r.warnings.some((w) => /Colors not set/.test(w)), `package without the level's colors: no palette, a warning (${r.warnings.join(' | ')})`);
  const s = fresh();
  const pl = planBgPack(s.rom, 'On-Off', importFiles, s.blank);
  const r2 = importLevelFile(s.rom, loadLevel(s.rom, LV), importFiles, pl, { bg: false, cgram: null, blank: s.blank });
  check(r2.ok && !customPalette(s.rom, LV) && r2.notes.some((w) => /Colors not set/.test(w)), `level import without the level's colors: the same (${r2.notes.join(' | ')})`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exitCode = 1;
