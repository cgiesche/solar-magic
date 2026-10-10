// Custom blocks (GPS format): block code runs for the right offsets, can change its acts-like
// (Y:$1693), an old SMWX install is upgraded, and removing the blocks restores normal behaviour.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeSprites, isL1Vertical, newUid, type Level } from '../src/core/level.ts';
import { installEditorPatch, DM16_EXT } from '../src/core/patches.ts';
import { setActsLike, setExtTileWords, map16Ext, blockOf } from '../src/core/map16ext.ts';
import { map16Source } from '../src/core/render.ts';
import { loadAsar } from '../src/core/asar.ts';
import { GPS_ROUTINES } from '../src/core/gpsroutines.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { saveBlockProject, loadBlockProject, removeBlocks, parseBlockList, writeBlockList, type BlockProject } from '../src/core/blocks.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();

const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
installEditorPatch(rom);
const emu = new LevelEmulator(rom); emu.boot();
const blank = map16Source(rom, emu.load(0x105)).fg(0x025);
const WALL = 0x2a0, PASS = 0x2a1, REF = 0x130;
for (const t of [WALL, PASS]) { setExtTileWords(rom, t, map16Source(rom, emu.load(0x105)).fg(REF), blank); setActsLike(rom, t, REF, blank); }
check(map16Ext(rom)?.version === 3 && !map16Ext(rom)?.blocks, 'SMWX v3 installed, blocks not yet enabled');

const OFFS = ['MarioBelow', 'MarioAbove', 'MarioSide', 'SpriteV', 'SpriteH', 'MarioCape', 'MarioFireball', 'TopCorner', 'BodyInside', 'HeadInside'];
// marker: sets bit n of $7FB010/11 for offset n
const marker = ['db $42', ...OFFS.map((o) => `JMP ${o}`),
  ...OFFS.map((o, i) => `${o}:\n  REP #$20 : LDA $7FB010 : ORA #$${(1 << i).toString(16).padStart(4, '0')} : STA $7FB010 : SEP #$20\n  RTL`)].join('\n');
// passable for Mario: acts like air for all of Mario's offsets, solid for sprites
const MARIO = ['MarioBelow', 'MarioAbove', 'MarioSide', 'TopCorner', 'BodyInside', 'HeadInside'];
const pass = ['db $42', ...OFFS.map((o) => `JMP ${o}`), ...OFFS.filter((o) => !MARIO.includes(o)).map((o) => `${o}:`), '  RTL',
  ...MARIO.map((o) => `${o}:`), '  %set_air()', '  RTL'].join('\n');
const project: BlockProject = {
  files: new Map(Object.entries({
    'blocks/marker.asm': marker,
    'blocks/pass.asm': pass,
    'routines/set_air.asm': 'LDY #$00 : LDA #$25 : STA $1693\nRTL\n',
  }).map(([k, v]) => [k, enc.encode(v)])),
  list: parseBlockList(`${WALL.toString(16)} marker.asm\n${PASS.toString(16)}:130 pass.asm\n`),
};
check(project.list.length === 2 && project.list[1].acts === REF && parseBlockList(writeBlockList(project.list)).length === 2, 'block list.txt parsed and written');

const r = saveBlockProject(rom, project, blank);
check(r.ok, 'blocks assemble and are entered ' + r.errors.join(' | '));
check(blockOf(rom, WALL) !== null && blockOf(rom, 0x2a2) === null, 'block table entries');
{
  // the registry speaks part kinds; the ROM keeps the stored string older editors wrote ("blocks")
  const raw = new TextDecoder('latin1').decode(rom.data);
  check(listPatches(rom).some((p) => p.kind === 'block') && raw.includes('"kind":"blocks"') && !raw.includes('"kind":"block"'), 'registered with part kind "block", stored as "blocks"');
}

// wall of the tile in front of Mario in level 105 plus a ledge; run right, jump periodically
const withWall = (tile: number, floor = REF): LevelOverride => {
  const lv: Level = loadLevel(rom, 0x105);
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 9, y: 14, size: 0x91, tile }); // 2×10 wall
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 4, y: 19, size: 0x02, tile }); // ledge
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0, y: 24, size: 0x08, tile: floor }); // floor under Mario
  return { layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode)) };
};
function play(tile: number, frames = 300, floor = REF, jump = true): { x: number; bits: number } {
  emu.load(0x105, withWall(tile, floor));
  const s = emu.snes, w = s.wram;
  let g = 0; while (w[0x100] !== 0x14 && g++ < 100) s.runFrame();
  w[0x1b010] = 0; w[0x1b011] = 0;
  for (let f = 0; f < frames; f++) { s.joy1 = 0x4100 | (jump && f % 50 < 22 ? 0x8000 : 0); s.runFrame(); }
  s.joy1 = 0;
  return { x: w[0x94] | (w[0x95] << 8), bits: w[0x1b010] | (w[0x1b011] << 8) };
}
// (the passable run doesn't jump: sprites still see the block as solid and gather at it)
const ref = play(REF), wall = play(WALL, 300, WALL), passing = play(PASS, 120, REF, false), refRun = play(REF, 120, REF, false);
const names = (b: number) => OFFS.filter((_, i) => b & (1 << i)).join(', ') || '–';
console.log(`     Mario x: cement ${ref.x}, marker block ${wall.x}, passable block ${passing.x}; offsets seen: ${names(wall.bits)}`);
check(wall.x === ref.x, 'a block acting like cement stops Mario like cement');
check((wall.bits & 0b110) === 0b110, 'MarioSide and MarioAbove reached the block code');
check(refRun.x < 150 && passing.x > refRun.x + 64, `a block that turns into air for Mario lets him through (${refRun.x} → ${passing.x})`);

// round trip through the ROM and removal
const back = loadBlockProject(rom);
check(!!back && back.list.length === 2 && back.files.size === 3, 'block project stored in the ROM');
removeBlocks(rom);
check(blockOf(rom, WALL) === null && play(PASS, 120, REF, false).x === refRun.x, 'removed: blocks behave like their acts-like again');

// SMWX v1 → v3 upgrade keeps tables
{
  const old = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
  installEditorPatch(old);
  const e = new LevelEmulator(old); e.boot();
  setActsLike(old, 0x2b0, 0x130, blank);
  const ex = map16Ext(old)!;
  old.w8(ex.base + 14, 0); // pretend version 1
  const up = saveBlockProject(old, { ...project, list: parseBlockList(`2B0 marker.asm\n`) }, blank);
  const nx = map16Ext(old)!;
  check(up.ok && nx.version === 3 && nx.base !== ex.base && nx.gfx === ex.gfx && old.r16(nx.acts + 0x2b0 * 2) === 0x130, 'SMWX v1 upgraded with its tables');
}

// GPS's standard routines are built in: every one assembles (called from code that never runs)
{
  const r2 = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
  installEditorPatch(r2);
  const names = Object.keys(GPS_ROUTINES).filter((n) => !/^[A-Z]/.test(n));
  const all = ['db $42', ...OFFS.map((o) => `JMP ${o}`), ...OFFS.map((o) => `${o}:`), '  RTL', ...names.map((n) => `  %${n}()`), '  RTL'].join('\n');
  const res = saveBlockProject(r2, { files: new Map([['blocks/all.asm', enc.encode(all)]]), list: parseBlockList('2C0 all.asm\n') }, blank);
  if (!res.ok) console.log(res.errors.join('\n'));
  check(res.ok, `all ${names.length} GPS routines assemble`);
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
