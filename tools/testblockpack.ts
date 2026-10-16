// Block packages: GPS list.txt + blocks + Lunar Magic .map16 + ExGFX for BG2, installed as one package;
// the blocks' tiles get the .map16 graphics (moved along when the tiles are taken), and with the level
// setup the tile shows the ExGFX graphics in the level (tiles 200+ from the BG2 slot).
import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { inspectUpload, installPackage, planUpload } from '../src/core/packages.ts';
import { editPlan, tileBlocks } from '../src/core/pkgplan.ts';
import { loadBlockProject } from '../src/core/blocks.ts';
import { parseMap16File } from '../src/core/map16file.ts';
import { blockOf, actsLike, extTileWords, setExtTileWords } from '../src/core/map16ext.ts';
import { levelExtGfx, levelGfx, gfxEntry, installEditorPatch, GFX_SLOT_NAMES } from '../src/core/patches.ts';
import { map16Source } from '../src/core/render.ts';
import { loadLevel, serializeLayer1, newUid } from '../src/core/level.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();

// a minimal LM16 file: 2x1 tiles, tile data + acts like
function lm16(tiles: number[][], acts: number[]): Uint8Array {
  const d = new Uint8Array(0xb0 + tiles.length * 10);
  d.set(enc.encode('LM16'));
  const w32 = (o: number, v: number) => { d[o] = v & 0xff; d[o + 1] = (v >> 8) & 0xff; d[o + 2] = (v >> 16) & 0xff; d[o + 3] = v >>> 24; };
  w32(0x10, 0x70); w32(0x18, tiles.length); w32(0x1c, 1);
  w32(0x70, 0xb0); w32(0x74, tiles.length * 8); w32(0x78, 0xb0 + tiles.length * 8); w32(0x7c, tiles.length * 2);
  tiles.forEach((t, i) => t.forEach((wd, k) => { d[0xb0 + i * 8 + k * 2] = wd & 0xff; d[0xb0 + i * 8 + k * 2 + 1] = wd >> 8; }));
  acts.forEach((a, i) => { d[0xb0 + tiles.length * 8 + i * 2] = a & 0xff; d[0xb0 + tiles.length * 8 + i * 2 + 1] = a >> 8; });
  return d;
}
const words = [[0x00f8, 0x08f8, 0x1a00, 0x1a10], [0x1a01, 0x1a11, 0x00f8, 0x08f8]];
const gfx = new Uint8Array(0x1000); for (let i = 0; i < gfx.length; i++) gfx[i] = (i * 5 + 1) & 0xff;
const block = 'db $42\nJMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A : JMP A\nA:\n  RTL\n';
const zip = zipSync({
  'Pack/list.txt': enc.encode('500:025 Left.asm\n501:025 Right.asm\n'),
  'Pack/Left.asm': enc.encode(block), 'Pack/Right.asm': enc.encode(block),
  'Pack/Tiles.map16': lm16(words, [0x25, 0x25]),
  'Pack/ExGFX80_BG2.bin': gfx,
  'Pack/readme.txt': enc.encode('read me'),
});

const preview = inspectUpload('Pack.zip', zip);
if (preview.status !== 'ready') throw new Error('Pack: ' + preview.status);
const found = preview.parts.flatMap((p) => (p.kind === 'block' ? p.found : []));
const gfxOf = (t: string) => preview.parts.filter((p) => p.kind === 'graphics' && p.type === t).length;
check(found.length === 2 && found.every((b) => b.tile !== undefined) && gfxOf('map16') === 1 && gfxOf('exgfx') === 1, 'detected: 2 blocks of a list.txt, Map16 tiles and ExGFX');
check(preview.unclaimed.join() === 'readme.txt' && preview.docs.includes('readme.txt'), `not installed: the readme only (${preview.unclaimed.join(', ')})`);
const m = parseMap16File(preview.files.get('Tiles.map16')!);
check(m.width === 2 && m.tiles[1][0] === 0x1a01 && m.acts?.[0] === 0x25, '.map16 parsed');

const fresh = () => { const r = new Rom(EDITOR_IMAGE.slice()); installEditorPatch(r); return r; };
const rom = fresh();
const emu = new LevelEmulator(rom); emu.boot();
const blank = map16Source(rom, emu.load(0x105)).fg(0x25);
const plan = planUpload(rom, preview, blank);
check(plan.blocks.map((b) => b.tiles.map((t) => t.toString(16)).join()).join(' ') === '500 501' && plan.map16?.at === 0x500 && plan.gfx[0]?.num === 0x80 && plan.gfx[0]?.slot === 'BG2', 'plan: blocks on 500/501, Map16 at 500, ExGFX 80 for BG2');
const opts = { blank, tileWords: () => blank };
{
  const r = await installPackage(rom, preview, { ...opts, level: 0x105, setup: false });
  check(r.ok, 'package installed without level setup: ' + [...r.errors, ...r.prints].join(' | '));
  check(!!blockOf(rom, 0x500) && !!blockOf(rom, 0x501) && actsLike(rom, 0x500) === 0x25, 'blocks and acts like on 500/501');
  check(extTileWords(rom, 0x501)?.join() === words[1].join(), 'Map16 graphics of 501');
  check(gfxEntry(rom, 0x80)?.raw === true && levelExtGfx(rom, 0x105)[0] === 0xff, 'ExGFX 80 stored, BG2 slot of the level left alone');
}

// the 500 taken: blocks and Map16 tiles move along to the next free run
{
  const rom = fresh();
  const one = inspectUpload('one.asm', enc.encode(block));
  if (one.status !== 'ready') throw new Error('one.asm: ' + one.status);
  const taken = await installPackage(rom, one, { ...opts, level: null });
  setExtTileWords(rom, 0x500, words[0]);
  const p = planUpload(rom, preview, blank);
  check(taken.ok && p.map16?.at === p.blocks[0].tiles[0] && p.blocks[1].tiles[0] === p.blocks[0].tiles[0] + 1 && p.blocks[0].tiles[0] !== 0x500 && p.notes.some((n) => /taken/.test(n)),
    `500 taken: blocks and Map16 tiles together from ${p.map16?.at.toString(16)}`);
}

// links changed in the preview: the .map16 at 700, the blocks swapped, the ExGFX as 90 for FG3
{
  const rom = fresh();
  const p0 = planUpload(rom, preview, blank);
  check(tileBlocks(p0).join() === 'Left.asm,Right.asm', 'links: Left on the first .map16 tile, Right on the second');
  const p = editPlan(p0, { map16At: 0x700, tileBlocks: ['Right.asm', 'Left.asm'], gfx: [{ num: 0x90, slot: 'FG3' }] });
  const r = await installPackage(rom, preview, { ...opts, level: 0x105, plan: p });
  const proj = loadBlockProject(rom)!;
  const on = (t: number) => proj.list.find((b) => b.tile === t)?.file;
  check(r.ok && on(0x700) === 'blocks/Right.asm' && on(0x701) === 'blocks/Left.asm' && extTileWords(rom, 0x701)?.join() === words[1].join() && !blockOf(rom, 0x500),
    'edited links installed: Right on 700, Left on 701 with the second tile\'s graphics');
  check(!!gfxEntry(rom, 0x90) && levelGfx(rom, 0x105)[GFX_SLOT_NAMES.indexOf('FG3')] === 0x90, 'edited ExGFX: stored as 90, FG3 of level 105');
  let err = '';
  try { editPlan(p0, { tileBlocks: ['Left.asm', 'Left.asm'], blockTiles: new Map([['Right.asm', [0x500]]]) }); } catch (e) { err = String(e); }
  check(/Two blocks on tile 500/.test(err), 'two blocks on one tile: refused');
}

// with the level setup the BG2 slot is used (VRAM patch installed for it): a placed tile 500 shows the
// package's graphics in the level
{
  const rom = fresh();
  const r = await installPackage(rom, preview, { ...opts, level: 0x105 });
  check(r.ok && levelExtGfx(rom, 0x105)[0] === 0x80, 'level setup: ExGFX 80 set as BG2 of level 105 ' + r.errors.join(' '));
  const e = new LevelEmulator(rom); e.boot();
  const lv = loadLevel(rom, 0x105);
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 4, y: 20, size: 0x00, tile: 0x500 });
  const l = e.load(0x105, { layer1: serializeLayer1(rom, lv) });
  let eq = 0; for (let i = 0; i < 0x1000; i++) if (l.vram[0x4000 + i] === gfx[i]) eq++;
  // block (4, 20) → tile column 8/9, tile row 40/41; the patched tilemap is 64x32 at $3000 (row 40 → 8)
  const at = (x: number, y: number) => { const a = 0x3000 + (y & 31) * 32 + x; return l.vram[a * 2] | (l.vram[a * 2 + 1] << 8); };
  const got = [at(8, 40), at(8, 41), at(9, 40), at(9, 41)];
  check(l.ok && eq === 0x1000 && got.join() === words[0].join(), `tile 500 in the level: words ${got.map((v) => v.toString(16)).join(' ')}, BG2 graphics ${eq}/4096`);
}

// the real package
{
  const rom2 = fresh();
  const real = inspectUpload('RockClimbBlocksUpdate.zip', new Uint8Array(readFileSync('test/fixtures/RockClimbBlocksUpdate.zip')));
  const rr = real.status === 'ready' ? await installPackage(rom2, real, { ...opts, level: 0x105 }) : null;
  check(!!rr?.ok, 'RockClimbBlocks: ' + (rr ? [...rr.errors, ...rr.prints].join(' | ') : real.status));
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
