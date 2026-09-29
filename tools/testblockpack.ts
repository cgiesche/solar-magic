// Block packages: GPS list.txt + blocks + Lunar Magic .map16 + ExGFX for BG2 in one step; the tile
// then shows the ExGFX graphics in the level (tiles 200+ from the BG2 slot).
import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { readPackage, detectKind } from '../src/core/patchpkg.ts';
import { planBlockPack, applyBlockPack } from '../src/core/blockpack.ts';
import { parseMap16File } from '../src/core/map16file.ts';
import { blockOf, actsLike, extTileWords } from '../src/core/map16ext.ts';
import { levelExtGfx, gfxEntry, installEditorPatch } from '../src/core/patches.ts';
import { map16Source } from '../src/core/render.ts';

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

const pkg = readPackage('Pack.zip', zip);
const info = detectKind(pkg);
check(info.kind === 'blockpack', 'detected as block package');
const m = parseMap16File(pkg.files.get('Tiles.map16')!);
check(m.width === 2 && m.tiles[1][0] === 0x1a01 && m.acts?.[0] === 0x25, '.map16 parsed');
const plan = planBlockPack(pkg, info.file);
check(plan.blocks.length === 2 && plan.map16?.at === 0x500 && plan.gfx[0]?.num === 0x80 && plan.gfx[0]?.slot === 'BG2' && !plan.missing.length, 'plan: 2 blocks, Map16 at 500, ExGFX 80 as BG2');

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
installEditorPatch(rom);
const emu = new LevelEmulator(rom); emu.boot();
const blank = map16Source(rom, emu.load(0x105)).fg(0x25);
const r = applyBlockPack(rom, pkg, plan, { blank, level: 0x105 });
check(r.ok, 'package applied: ' + [...r.errors, ...r.notes].join(' | '));
check(!!blockOf(rom, 0x500) && !!blockOf(rom, 0x501) && actsLike(rom, 0x500) === 0x25, 'blocks and acts like on 500/501');
check(extTileWords(rom, 0x501)?.join() === words[1].join(), 'Map16 graphics of 501');
check(gfxEntry(rom, 0x80)?.raw === true && levelExtGfx(rom, 0x105)[0] === 0x80, 'ExGFX 80 stored and set as BG2 of level 105');
emu.syncRom();
const l = emu.load(0x105);
let eq = 0; for (let i = 0; i < 0x1000; i++) if (l.vram[0x4000 + i] === gfx[i]) eq++;
check(l.ok && eq === 0x1000, `ExGFX in VRAM for the tiles 200+ (${eq}/4096)`);

// the real package, if present locally
try {
  const real = readPackage('RockClimbBlocksUpdate.zip', new Uint8Array(readFileSync('resources_local/RockClimbBlocksUpdate.zip')));
  const ri = detectKind(real);
  const rp = planBlockPack(real, ri.file);
  const rom2 = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const rr = applyBlockPack(rom2, real, rp, { blank, level: 0x105 });
  check(ri.kind === 'blockpack' && rr.ok, 'RockClimbBlocks: ' + [...rr.errors, ...rr.notes].join(' | '));
} catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
