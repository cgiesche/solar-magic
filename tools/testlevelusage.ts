// Where Map16 tiles, GFX files and sprites are used across the ROM's levels (levelusage.ts): the tiles a
// level places (by object, Direct Map16, structure; its BG tilemap) are learned by loading it in the
// emulator and stay valid while the ROM bytes and level data they came from are unchanged; GFX slots
// and sprites are read from the ROM.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, newUid, spriteId } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { DM16_EXT, setGfxEntry, levelGfx, setLevelGfx } from '../src/core/patches.ts';
import { STRUCT_EXT, writeStructure, TRANSPARENT } from '../src/core/structs.ts';
import { setActsLike, setExtTileWords, extTileWords } from '../src/core/map16ext.ts';
import { ResultCache, RomFingerprint } from '../src/core/romdeps.ts';
import { map16Source } from '../src/core/render.ts';
import {
  LevelUses, usedLevels, fgTileUsers, bgTileUsers, tileLinks, unusedFgTiles, gfxUsage, unusedExGfx, spriteUsage, slotMove, type GfxSlot,
} from '../src/core/levelusage.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

const rom = new Rom(await editorImage());
const results = new ResultCache(new RomFingerprint(rom));
const emu = new LevelEmulator(rom); emu.boot();
const uses = new LevelUses(rom, results, () => emu);
const blank = map16Source(rom, emu.load(0x105)).fg(0x025);

// level 105 as saved: a Direct Map16 tile, a structure with another one, both on layer 1
const lv = loadLevel(rom, 0x105);
writeStructure(rom, 7, { w: 2, h: 1, tiles: [0x346, TRANSPARENT], name: 'test' });
lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0x20, y: 0x10, size: 0x01, tile: 0x345 }); // 2×1
lv.objects.push({ uid: newUid(), num: 0, ext: STRUCT_EXT, x: 0x30, y: 0x12, size: 0, struct: 7 });
saveLevel(rom, lv);
setExtTileWords(rom, 0x345, [1, 2, 3, 4]);
setExtTileWords(rom, 0x346, [1, 2, 3, 5]);
setExtTileWords(rom, 0x348, [1, 2, 3, 6]); // defined, used nowhere
setActsLike(rom, 0x347, 0x130); // (acts like reaches the game's tiles 000-1FF)

const levels = usedLevels(rom);
check(levels.includes(0x105) && levels.includes(0x0) && levels.includes(0x13b), `used levels: ${levels.length}`);
check(uses.tiles(0x105) === undefined, 'nothing known before scanning');
const all = levels.map((n) => uses.tiles(n) ?? uses.scan(n));
check(uses.missing(levels).length === 0, 'every level known after scanning');

{
  const u = fgTileUsers(all, 0x345, [0]);
  const r = u.find((x) => x.level === 0x105)?.uses ?? [];
  check(u.length === 1 && r.length === 1 && r[0].source === 'direct' && r[0].layer === 1 && r[0].count === 2 && r[0].x === 0x20 && r[0].y === 0x10,
    `Direct Map16 tile 345: level 105, 2×, at 20/10 (${JSON.stringify(u)})`);
  const s = fgTileUsers(all, 0x346, [0])[0]?.uses ?? [];
  check(s.length === 1 && s[0].source === 'structure' && s[0].count === 1 && s[0].x === 0x30 && s[0].y === 0x12, `structure tile 346 at 30/12 (${JSON.stringify(s)})`);
}

// a standard tile of the game: objects in many levels, its first place is where it is in the level
{
  const u = fgTileUsers(all, 0x100, [0]);
  check(u.length > 10 && u.every((x) => x.uses.every((q) => q.source === 'object')), `tile 100 placed by objects in ${u.length} levels`);
  const lv105 = u.find((x) => x.level === 0x105);
  check(!!lv105 && lv105.uses[0].count > 50, `level 105: ${lv105?.uses[0].count}× tile 100`);
}

// tileset tiles (073-0FF) are another tile in each group of tilesets: only levels of the given tilesets count
{
  const tilesetOf = (n: number) => all.find((t) => t.level === n)!.tileset;
  const group = [2, 6, 8], mixed: number[] = [];
  let only = true;
  for (let t = 0x73; t < 0x100; t++) {
    const u = fgTileUsers(all, t, group), one = fgTileUsers(all, t, [1]);
    only &&= u.every((x) => group.includes(tilesetOf(x.level))) && one.every((x) => tilesetOf(x.level) === 1);
    if (new Set(u.map((x) => tilesetOf(x.level))).size > 1) mixed.push(t);
  }
  check(only && mixed.length > 0, `tileset tiles: levels of those tilesets only (tiles in levels of several of 2, 6, 8: ${mixed.length})`);
}

// the BG tilemap's tiles
{
  const t = all.find((x) => x.level === 0x105)!;
  check(t.bg.length > 0 && t.bg.reduce((s, b) => s + b.count, 0) === 32 * 27, `level 105's BG: ${t.bg.length} different BG tiles in 32×27`);
  const b = t.bg[0];
  check(bgTileUsers(all, b.tile).some((u) => u.level === 0x105 && u.count === b.count), `BG tile ${b.tile.toString(16)} used in level 105`);
}

// links: the tiles acting like it, structures holding it, blocks on it
{
  const l = tileLinks(rom, 0x130);
  check(l.actsLike.includes(0x347) && !l.actsLike.includes(0x130), `tile 347 acts like 130 (${l.actsLike.map((x) => x.toString(16))})`);
  check(tileLinks(rom, 0x346).structures.includes(7), 'structure 07 holds tile 346');
  check(Array.isArray(l.blocks), 'blocks on the tile');
}

// defined Map16 tiles (200-FFF) used nowhere
{
  const u = unusedFgTiles(rom, all, blank);
  check(u.includes(0x348) && u.includes(0x347) && !u.includes(0x345) && !u.includes(0x346) && !u.includes(0x349), `unused tiles: ${u.map((x) => x.toString(16))}`);
}

// validity: saving level 105 again scans it anew, the other levels stay known; an unrelated ROM change keeps all
{
  rom.allocWrite(Uint8Array.of(1, 2, 3)); // into free space no level load reads
  check(uses.missing(levels).length === 0, 'an unrelated ROM change keeps every result');
  const before = extTileWords(rom, 0x345);
  const l2 = loadLevel(rom, 0x105);
  l2.objects = l2.objects.filter((o) => o.tile !== 0x345);
  saveLevel(rom, l2);
  const m = uses.missing(levels);
  check(m.length === 1 && m[0] === 0x105, `after saving level 105 only it is scanned again (${m.map((x) => x.toString(16))})`);
  const again = uses.scan(0x105);
  check(!fgTileUsers([again], 0x345, [0]).length && !!before, 'the new scan no longer has tile 345');
  // a stored result is found again by a new index on the same cache
  check(new LevelUses(rom, results, () => emu).tiles(0x105) !== undefined, 'results come from the result cache');
}

// GFX files: the slots of each level (defaults of the tileset included), ExGFX inserted but in no slot
{
  setGfxEntry(rom, 0x80, rom.allocWrite(new Uint8Array(0x1000)), true);
  setGfxEntry(rom, 0x81, rom.allocWrite(new Uint8Array(0x1000)), true);
  const g = levelGfx(rom, 0x105); g[7] = 0x80; setLevelGfx(rom, 0x105, g); // FG1
  const usage = gfxUsage(rom, levels);
  const u80 = usage.get(0x80) ?? [];
  check(u80.length === 1 && u80[0].level === 0x105 && u80[0].slots.join() === 'FG1', `ExGFX 80 in level 105 as FG1 (${JSON.stringify(u80)})`);
  check((usage.get(0x00)?.length ?? 0) > 10, 'GFX 00 (a sprite default) in many levels');
  const un = unusedExGfx(rom, levels);
  check(un.includes(0x81) && !un.includes(0x80), `inserted, unused ExGFX: ${un.map((x) => x.toString(16))}`);
}

// sprites: levels with the sprite, how many and the first
{
  const lv105 = loadLevel(rom, 0x105), s = lv105.sprites[0];
  const usage = spriteUsage(rom, levels);
  const id = spriteId(s);
  const u = (usage.get(id) ?? []).find((x) => x.level === 0x105);
  const n = lv105.sprites.filter((q) => spriteId(q) === id).length;
  check(!!u && u.count === n && u.x === s.x && u.y === s.y, `sprite ${s.num.toString(16)}: level 105, ${n}×, first at ${s.x}/${s.y} (${JSON.stringify(u)})`);
}

// slotMove: where a level's Map16 tiles were made for when a file changes slots (the remap offer)
{
  const slot = (name: string, first: number, file: number, custom = true): GfxSlot => ({ name, kind: 'gfx', k: 0, file, def: 0x1b, custom, first, sprite: false, map16: true });
  const lv = (bg1: number, bg2: number, bg1custom = true) => [slot('FG1', 0, 0x14, false), slot('BG1', 0x100, bg1, bg1custom), slot('BG2', 0x200, bg2, bg2 !== 0xff)];
  const none = new Map();
  let m = slotMove(lv(0x80, 0x80), lv(0x1b, 0x80, false), 'BG1', none, 0x105);
  check(m?.file === 0x80 && m.from.name === 'BG1' && m.to.name === 'BG2' && m.levels === 0, 'ExGFX80 left BG1 and is still in BG2: moved from BG1 to BG2');
  check(slotMove(lv(0x1b, 0xff, false), lv(0x1b, 0x80, false), 'BG2', none, 0x105) === null, 'a new file used nowhere else: nothing to offer');
  check(slotMove(lv(0x80, 0xff), lv(0x80, 0x80), 'BG2', none, 0x105) === null, 'also still in BG1: its tiles still fit');
  const usage = new Map([[0x80, [{ level: 0x106, slots: ['BG1'] }, { level: 0x107, slots: ['BG1'] }, { level: 0x105, slots: ['BG2'] }]]]);
  m = slotMove(lv(0x1b, 0xff, false), lv(0x1b, 0x80, false), 'BG2', usage, 0x105);
  check(m?.from.name === 'BG1' && m.to.name === 'BG2' && m.levels === 2, 'other levels have it in BG1: from BG1, 2 levels');
  check(slotMove(lv(0x1b, 0xff, false), lv(0x1b, 0x13, false), 'BG2', new Map([[0x13, [{ level: 0x106, slots: ['BG1'] }]]]), 0x105) === null, 'vanilla GFX: no offer');
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('level usage ok');
