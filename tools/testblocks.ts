// Custom blocks (GPS format): block code runs for the right offsets, can change its acts-like
// (Y:$1693), an old SMWX install is upgraded, and removing the blocks restores normal behaviour. Built as
// GPS builds them: each block on its own, a shared routine once (with the defines of the first block
// using it); list.txt with tile ranges and Lunar Magic's tile descriptions (@dsc).
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, serializeSprites, isL1Vertical, newUid, type Level } from '../src/core/level.ts';
import { installEditorPatch, DM16_EXT } from '../src/core/patches.ts';
import { setActsLike, setExtTileWords, map16Ext, blockOf, setBlock } from '../src/core/map16ext.ts';
import { map16Source } from '../src/core/render.ts';
import { loadAsar } from '../src/core/asar.ts';
import { GPS_ROUTINES } from '../src/core/gpsroutines.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { saveBlockProject, loadBlockProject, removeBlocks, parseBlockList, writeBlockList, type BlockProject } from '../src/core/blocks.ts';
import { editorImage } from './fixture.ts';
import { RAM } from '../src/core/ram.ts';

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

// the hook at $00F545, called as each caller calls it (its return address on the stack): the GPS offset the block
// is entered at (Mario's interaction point in X and his Y speed $7D, a sprite's direction in $0F), the caller's X and the
// block's data bank there; the wall offsets only for "db $37"; a tile without a block or a caller without an offset
// goes on with its acts-like; afterwards the vanilla routine (page 0 at $F54B with Y = $1693, page 1 at $F577) with
// the caller's X, data bank and stack
{
  const r3 = new Rom(EDITOR_IMAGE.slice());
  const NONE = 0x2a4, FLOOR = 0x2a5, WALLS = 0x2a6, AIR = 0x2a7;
  const code = r3.allocWrite(new Uint8Array(12 * 3).fill(0x6b)); // every offset: RTL
  setActsLike(r3, NONE, REF); setActsLike(r3, FLOOR, REF); setActsLike(r3, WALLS, REF); setActsLike(r3, AIR, 0x025);
  setBlock(r3, FLOOR, code, false); setBlock(r3, WALLS, code, true); setBlock(r3, AIR, code, false);
  const e3 = new LevelEmulator(r3); e3.boot(); e3.load(0x105);
  const s = e3.snes, cpu = s.cpu, w = s.wram;
  // (in the slow and the fast banks: the caller's bank is told without bit 7)
  const MARIO = 0x80f4df, SPRITE = 0x019535, CAPE = 0x82961c, FIRE = 0x02a6ed, OTHER = 0x018000;
  const call = (from: number, tile: number, x: number, ram: Record<number, number> = {}) => {
    for (const [k, v] of Object.entries(ram)) w[+k] = v;
    w[0x1693] = tile & 0xff;
    const s0 = 0x1f0;
    w[s0] = from >> 16; w[s0 - 1] = (from >> 8) & 0xff; w[s0 - 2] = from & 0xff; // as JSL pushes it
    Object.assign(cpu, { e: false, p: 0x34, a: tile >> 8, x, y: 0x99, s: s0 - 3, d: 0, dbr: 0x81, pbr: 0x80, pc: 0xf545, nmiPending: false });
    let entry = -1, xAt = -1, dbAt = -1;
    for (let i = 0; i < 400; i++) {
      cpu.step();
      const pc = (cpu.pbr << 16) | cpu.pc;
      if (entry < 0 && pc >= code && pc < code + 36) { entry = (pc - code) / 3; xAt = cpu.x; dbAt = cpu.dbr; }
      if ((pc & 0x7fffff) === 0xf54b || (pc & 0x7fffff) === 0xf577) {
        const back = cpu.x === x && cpu.dbr === 0x81 && cpu.s === s0 - 3 && (cpu.p & 0x30) === 0x30;
        return { entry, xAt, dbAt, page: (pc & 0xffff) === 0xf54b ? 0 : 1, acts: w[0x1693], y: cpu.y, back };
      }
    }
    return null;
  };
  const at = (from: number, tile: number, x: number, ram: Record<number, number> = {}) => call(from, tile, x, ram)?.entry;
  const cases: [string, number | undefined, number][] = [
    ['Mario, body point', at(MARIO, FLOOR, 0x02), 8],
    ['Mario, side', at(MARIO, FLOOR, 0x04), 2],
    ['Mario, head, falling', at(MARIO, FLOOR, 0x08, { [RAM.marioSpeedY]: 0x10 }), 9],
    ['Mario, head, rising', at(MARIO, FLOOR, 0x08, { [RAM.marioSpeedY]: 0xf0 }), 0],
    ['Mario, feet, falling', at(MARIO, FLOOR, 0x0b, { [RAM.marioSpeedY]: 0x10 }), 1],
    ['Mario, feet, rising', at(MARIO, FLOOR, 0x17, { [RAM.marioSpeedY]: 0xf0 }), 7],
    ['Mario on a wall, feet, "db $37"', at(MARIO, WALLS, 0x62), 10],
    ['Mario on a wall, body, "db $37"', at(MARIO, WALLS, 0x66), 11],
    ['Mario on a wall, "db $42": no block', at(MARIO, FLOOR, 0x62), -1],
    ['a sprite, a side (left/right)', at(SPRITE, FLOOR, 0x05, { 0x0f: 0 }), 4],
    ['a sprite, floor or ceiling', at(SPRITE, FLOOR, 0x05, { 0x0f: 2 }), 3],
    ['the cape', at(CAPE, FLOOR, 0x00), 5],
    ['a fireball', at(FIRE, FLOOR, 0x09), 6],
    ['another caller: no block', at(OTHER, FLOOR, 0x00), -1],
    ['a tile without a block', at(MARIO, NONE, 0x02), -1],
  ];
  for (const [what, got, want] of cases) check(got === want, `${what}: offset ${got} (${want})`);
  const r = call(SPRITE, FLOOR, 0x05, { 0x0f: 0 });
  check(!!r && r.xAt === 0x05 && r.dbAt === code >> 16, `the block gets the caller's X ($${r?.xAt.toString(16)}) and its own data bank ($${r?.dbAt.toString(16)})`);
  check(!!r && r.back && r.page === 1 && r.acts === (REF & 0xff), 'after the block: page 1 of its acts-like, the caller\'s X, data bank and stack');
  const air = call(MARIO, AIR, 0x02), none = call(MARIO, NONE, 0x02), off = call(OTHER, AIR, 0x02);
  check(!!air && air.back && air.page === 0 && air.acts === 0x25 && air.y === 0x25, 'after the block: page 0 with Y = $1693 = its acts-like');
  check(!!none && none.back && none.page === 1 && none.acts === (REF & 0xff), 'a tile without a block: its acts-like on page 1');
  check(!!off && off.back && off.page === 0 && off.y === 0x25, 'a caller without an offset: its acts-like on page 0, Y = $1693');
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
