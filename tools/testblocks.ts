// Custom blocks (GPS format): block code runs for the right offsets, can change its acts-like
// (Y:$1693), an old SMWX install is upgraded, and removing the blocks restores normal behaviour. Built as
// GPS builds them: each block on its own, a shared routine once (with the defines of the first block
// using it); list.txt with tile ranges and Lunar Magic's tile descriptions (@dsc).
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
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();

const rom = new Rom(EDITOR_IMAGE.slice());
installEditorPatch(rom);
const emu = new LevelEmulator(rom); emu.boot();
const WALL = 0x2a0, PASS = 0x2a1, REF = 0x130;
for (const t of [WALL, PASS]) { setExtTileWords(rom, t, map16Source(rom, emu.load(0x105)).fg(REF)); setActsLike(rom, t, REF); }
check(!!map16Ext(rom)?.blocks, 'SMWX installed with the block table');

const OFFS = ['MarioBelow', 'MarioAbove', 'MarioSide', 'SpriteV', 'SpriteH', 'MarioCape', 'MarioFireball', 'TopCorner', 'BodyInside', 'HeadInside'];
// marker: sets bit n of $7FB010/11 for offset n; the data bank it runs with in $7FB012, its own bank in $7FB013
const marker = ['db $42', ...OFFS.map((o) => `JMP ${o}`),
  ...OFFS.map((o, i) => `${o}:\n  REP #$20 : LDA $7FB010 : ORA #$${(1 << i).toString(16).padStart(4, '0')} : STA $7FB010 : SEP #$20\n  PHB : PLA : STA $7FB012 : PHK : PLA : STA $7FB013\n  RTL`)].join('\n');
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

const r = saveBlockProject(rom, project);
check(r.ok, 'blocks assemble and are entered ' + r.errors.join(' | '));
check(blockOf(rom, WALL) !== null && blockOf(rom, 0x2a2) === null, 'block table entries');
{
  check(listPatches(rom).some((p) => p.kind === 'block'), 'registered with part kind "block"');
}

// wall of the tile in front of Mario in level 105 plus a ledge; run right, jump periodically
const withWall = (tile: number, floor = REF): LevelOverride => {
  const lv: Level = loadLevel(rom, 0x105);
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 9, y: 14, size: 0x91, tile }); // 2×10 wall
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 4, y: 19, size: 0x02, tile }); // ledge
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0, y: 24, size: 0x08, tile: floor }); // floor under Mario
  return { layer1: serializeLayer1(rom, lv), sprites: serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode)) };
};
function play(tile: number, frames = 300, floor = REF, jump = true): { x: number; bits: number; dbr: number; bank: number } {
  emu.load(0x105, withWall(tile, floor));
  const s = emu.snes, w = s.wram;
  let g = 0; while (w[0x100] !== 0x14 && g++ < 100) s.runFrame();
  w[0x1b010] = 0; w[0x1b011] = 0; w[0x1b012] = 0; w[0x1b013] = 0;
  for (let f = 0; f < frames; f++) { s.joy1 = 0x4100 | (jump && f % 50 < 22 ? 0x8000 : 0); s.runFrame(); }
  s.joy1 = 0;
  return { x: w[0x94] | (w[0x95] << 8), bits: w[0x1b010] | (w[0x1b011] << 8), dbr: w[0x1b012], bank: w[0x1b013] };
}
// (the passable run doesn't jump: sprites still see the block as solid and gather at it)
const ref = play(REF), wall = play(WALL, 300, WALL), passing = play(PASS, 120, REF, false), refRun = play(REF, 120, REF, false);
const names = (b: number) => OFFS.filter((_, i) => b & (1 << i)).join(', ') || '–';
console.log(`     Mario x: cement ${ref.x}, marker block ${wall.x}, passable block ${passing.x}; offsets seen: ${names(wall.bits)}`);
check(wall.x === ref.x, 'a block acting like cement stops Mario like cement');
check((wall.bits & 0b110) === 0b110, 'MarioSide and MarioAbove reached the block code');
// as GPS runs it: blocks read their own tables by absolute addresses (the game goes on with its own data bank)
check(wall.bank !== 0 && wall.dbr === wall.bank, `the block code runs with its own bank as the data bank ($${wall.dbr.toString(16)}, block in $${wall.bank.toString(16)})`);
check(refRun.x < 150 && passing.x > refRun.x + 64, `a block that turns into air for Mario lets him through (${refRun.x} → ${passing.x})`);

// round trip through the ROM and removal
const back = loadBlockProject(rom);
check(!!back && back.list.length === 2 && back.files.size === 3, 'block project stored in the ROM');
removeBlocks(rom);
check(blockOf(rom, WALL) === null && play(PASS, 120, REF, false).x === refRun.x, 'removed: blocks behave like their acts-like again');

// GPS's standard routines are built in: every one assembles (called from code that never runs)
{
  const r2 = new Rom(EDITOR_IMAGE.slice());
  installEditorPatch(r2);
  const names = Object.keys(GPS_ROUTINES).filter((n) => !/^[A-Z]/.test(n));
  const all = ['db $42', ...OFFS.map((o) => `JMP ${o}`), ...OFFS.map((o) => `${o}:`), '  RTL', ...names.map((n) => `  %${n}()`), '  RTL'].join('\n');
  const res = saveBlockProject(r2, { files: new Map([['blocks/all.asm', enc.encode(all)]]), list: parseBlockList('2C0 all.asm\n') });
  if (!res.ok) console.log(res.errors.join('\n'));
  check(res.ok, `all ${names.length} GPS routines assemble`);
}

// as GPS builds: blocks defining the same macro; a routine with sublabels, one using a define of the
// block calling it, and a block's sublabel after a routine call
{
  const r2 = new Rom(EDITOR_IMAGE.slice());
  installEditorPatch(r2);
  const head = ['db $42', ...OFFS.map((o) => `JMP ${o}`), ...OFFS.filter((o) => o !== 'MarioAbove').map((o) => `${o}:`), '  RTL'].join('\n');
  const withMacro = (n: number) => `macro say(x)\n  print "<x>"\nendmacro\n%say(${n})\n!pipe_dir = $7FB0${n}0\n${head}\nMarioAbove:\n  %count()\n  %dir()\n  BRA .done\n.done\n  RTL\n`;
  const p2: BlockProject = {
    files: new Map(Object.entries({
      'blocks/a.asm': withMacro(1), 'blocks/b.asm': withMacro(2),
      'routines/count.asm': 'LDX #$05\n.loop\n  DEX\n  BPL .loop\nRTL\n',
      'routines/dir.asm': 'LDA !pipe_dir\nRTL\n',
    }).map(([k, v]) => [k, enc.encode(v)])),
    list: parseBlockList('2C0-2C1 a.asm\n2C2 b.asm\n\n; descriptions\n@dsc\n2C0 0 Some block.\n'),
  };
  check(p2.list.map((b) => b.tile.toString(16)).join() === '2c0,2c1,2c2', 'list.txt: a tile range, the @dsc section not read');
  const res = saveBlockProject(r2, p2);
  check(res.ok && res.prints.join() === '1,2', 'blocks defining the same macro, each assembled on its own ' + res.errors.join(' | '));
  const runs = res.steps ?? [];
  const at = (n: string) => runs.map((x) => x.labels[`GpsRoutine_${n}`]).filter((x) => x !== undefined);
  // the routine reading !pipe_dir is put with block a (its define $7FB010), block b calls it there
  const dir = at('dir')[0];
  check(at('count').length === 1 && at('dir').length === 1 && dir !== undefined && r2.r8(dir) === 0xaf && r2.r8(dir + 1) === 0x10 && r2.r8(dir + 2) === 0xb0, 'shared routines put once, with the first block\'s defines');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
