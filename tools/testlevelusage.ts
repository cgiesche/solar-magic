// Where Map16 tiles, GFX files and sprites are used across the ROM's levels (levelusage.ts): the tiles a
// level places (by object, Direct Map16, prefab; its BG tilemap) are learned by loading it in the
// emulator and stay valid while the ROM bytes and level data they came from are unchanged; GFX slots
// and sprites are read from the ROM.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, newUid, spriteId, storedBgAddr, levelDataRanges, hasLayer2Objects, L1_PTRS, L2_PTRS } from '../src/core/level.ts';
import { bgFromWram, bgDataSize } from '../src/core/bg.ts';
import { saveLevel } from '../src/core/save.ts';
import { DM16_EXT, setGfxEntry, levelGfx, setLevelGfx, editorPatch, setCustomPalette, bgBank, setBgBank } from '../src/core/patches.ts';
import { PREFAB_EXT, writePrefab, TRANSPARENT } from '../src/core/prefabs.ts';
import { setActsLike, setExtTileWords, extTileWords } from '../src/core/map16ext.ts';
import { ResultCache, RomFingerprint, RomReads, PAGE_SHIFT, bytePages, type RomDeps } from '../src/core/romdeps.ts';
import { captureSprites } from '../src/core/spritegfx.ts';
import { ProbeHost } from '../src/core/probehost.ts';
import { jobKey, type ProbeJob } from '../src/core/probeprotocol.ts';
import { map16Source } from '../src/core/render.ts';
import {
  LevelUses, usedLevels, fgTileUsers, bgTileUsers, tileLinks, unusedFgTiles, gfxUsage, unusedExGfx, spriteUsage, slotMove,
} from '../src/core/levelusage.ts';
import { levelSlots, layerSlots, type GfxSlot } from '../src/core/gfxslots.ts';
import { gfxFilesHash } from '../src/core/gfxpages.ts';
import { readGfx, writeGfx } from '../src/core/gfxfiles.ts';
import { lz2Decompress } from '../src/core/lz2.ts';
import { thumbsInput } from '../src/core/objthumbs.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

const rom = new Rom(await editorImage());
const results = new ResultCache(new RomFingerprint(rom));
const emu = new LevelEmulator(rom);
emu.boot();
const uses = new LevelUses(rom, results);
// a level scanned here: what it read recorded as a picture's (with the display data, without graphics file data), as
// this file's checks of what an edit drops expect; the editor's scans show behaviour (testlearner.ts: display data)
const scan = (n: number) => emu.record('picture', () => uses.scan(n, emu)).result;
const blank = map16Source(rom, emu.load(0x105)).fg(0x025);
// free space for an unrelated change later: a page of its own, which no level load reads (its RATS tag may share one)
const spare = rom.allocWrite(new Uint8Array(0x300));

// level 105 as saved: a Direct Map16 tile, a prefab with another one, both on layer 1
const lv = loadLevel(rom, 0x105);
writePrefab(rom, 7, { w: 2, h: 1, tiles: [0x346, TRANSPARENT], name: 'test' });
lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 0x20, y: 0x10, size: 0x01, tile: 0x345 }); // 2×1
lv.objects.push({ uid: newUid(), num: 0, ext: PREFAB_EXT, x: 0x30, y: 0x12, size: 0, prefab: 7 });
saveLevel(rom, lv);
setExtTileWords(rom, 0x345, [1, 2, 3, 4]);
setExtTileWords(rom, 0x346, [1, 2, 3, 5]);
setExtTileWords(rom, 0x348, [1, 2, 3, 6]); // defined, used nowhere
setActsLike(rom, 0x347, 0x130); // (acts like reaches the game's tiles 000-1FF)

const levels = usedLevels(rom);
check(levels.includes(0x105) && levels.includes(0x0) && levels.includes(0x13b), `used levels: ${levels.length}`);
check(uses.tiles(0x105) === undefined, 'nothing known before scanning');
const all = levels.map((n) => uses.tiles(n) ?? scan(n));
check(uses.missing(levels).length === 0, 'every level known after scanning');

{
  const u = fgTileUsers(all, 0x345, [0]);
  const r = u.find((x) => x.level === 0x105)?.uses ?? [];
  check(u.length === 1 && r.length === 1 && r[0].source === 'direct' && r[0].layer === 1 && r[0].count === 2 && r[0].x === 0x20 && r[0].y === 0x10,
    `Direct Map16 tile 345: level 105, 2×, at 20/10 (${JSON.stringify(u)})`);
  const s = fgTileUsers(all, 0x346, [0])[0]?.uses ?? [];
  check(s.length === 1 && s[0].source === 'prefab' && s[0].count === 1 && s[0].x === 0x30 && s[0].y === 0x12, `prefab tile 346 at 30/12 (${JSON.stringify(s)})`);
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

// links: the tiles acting like it, prefabs holding it, blocks on it
{
  const l = tileLinks(rom, 0x130);
  check(l.actsLike.includes(0x347) && !l.actsLike.includes(0x130), `tile 347 acts like 130 (${l.actsLike.map((x) => x.toString(16))})`);
  check(tileLinks(rom, 0x346).prefabs.includes(7), 'prefab 07 holds tile 346');
  check(Array.isArray(l.blocks), 'blocks on the tile');
}

// defined Map16 tiles (200-FFF) used nowhere
{
  const u = unusedFgTiles(rom, all, blank);
  check(u.includes(0x348) && u.includes(0x347) && !u.includes(0x345) && !u.includes(0x346) && !u.includes(0x349), `unused tiles: ${u.map((x) => x.toString(16))}`);
}

// validity: saving level 105 again scans it anew, the other levels stay known; an unrelated ROM change keeps all
{
  rom.w8(spare + 0x180, 1);
  check(uses.missing(levels).length === 0, 'an unrelated ROM change keeps every result');
  const before = extTileWords(rom, 0x345);
  const l2 = loadLevel(rom, 0x105);
  l2.objects = l2.objects.filter((o) => o.tile !== 0x345);
  saveLevel(rom, l2);
  const m = uses.missing(levels);
  check(m.length === 1 && m[0] === 0x105, `after saving level 105 only it is scanned again (${m.map((x) => x.toString(16))})`);
  const again = scan(0x105);
  check(!fgTileUsers([again], 0x345, [0]).length && !!before, 'the new scan no longer has tile 345');
  // a stored result is found again by a new index on the same cache
  check(new LevelUses(rom, results).tiles(0x105) !== undefined, 'results come from the result cache');
}

// validity of what the boot read (every result counts it): the title screen's level shares pages of level data
// with others; saving one of them keeps the boot snapshot, the probes, the sprite images and the other levels' uses
{
  const lv105 = loadLevel(rom, 0x105), bg = lv105.layer2Pointer >> 16 === 0xff ? lv105.layer2Pointer : 0xffd900;
  const images = results.fp.deps(emu.record('picture', () => captureSprites(emu, { number: 0x105, header: lv105.header, spriteHeader: lv105.spriteHeader, bgPointer: bg }, [0x04, 0x05, 0x0d])).reads);
  const host = new ProbeHost(), probes = new Map<string, RomDeps>();
  const jobs: ProbeJob[] = [{ kind: 'block', ts: 0, tile: 0x130 }, { kind: 'block', ts: 0, tile: 0x12b }, { kind: 'sprite', ts: 0, num: 0x04 }];
  host.setRom(rom.gen, rom.data.slice());
  host.ask(jobs);
  while (host.pending) { const d = host.next(); if (d?.type === 'probe') for (const [k, e] of d.put) probes.set(k, e.deps); }
  const base = () => { emu.load(0x105); return emu.snapshot; };
  let state = base();
  const kept = (what: string, level: number) => {
    const m = uses.missing(levels), s = base();
    check(s === state, `${what}: the boot snapshot is kept`);
    check(m.length === 1 && m[0] === level, `${what}: only level ${level.toString(16)} is scanned again (${m.map((x) => x.toString(16))})`);
    check(results.fp.valid(images), `${what}: the sprite images are kept`);
    check(jobs.every((j) => probes.has(jobKey(j))) && [...probes.values()].every((d) => results.fp.valid(d)), `${what}: the block and sprite probes are kept`);
    for (const n of m) scan(n);
    state = s;
  };
  // the boot loads the title screen's level: the level whose pointer it read
  const boot = emu.snapshot!.reads;
  const title = Array.from({ length: 0x200 }, (_, n) => n).filter((n) => boot.bytes.has(snesToPc(L1_PTRS + n * 3)));
  const shares = (n: number) => { const p = snesToPc(loadLevel(rom, n).l1Addr) >> PAGE_SHIFT; return !!boot.pages[p] || [...boot.bytes].some((b) => b >> PAGE_SHIFT === p); };
  check(title.length === 1, `the boot loads one level (${title.map((x) => x.toString(16))})`);
  check([0x000, 0x014, 0x11b].every(shares), 'levels 000, 014, 11B: their layer 1 data starts on a page the boot read');
  const s105 = loadLevel(rom, 0x105), at = s105.sprAddr;
  s105.sprites[0].x++;
  saveLevel(rom, s105);
  check(s105.sprAddr === at, 'level 105 with a sprite moved is saved in place');
  kept('saving level 105 with a sprite moved', 0x105);
  for (const n of [0x000, 0x014, 0x11b]) {
    const lv = loadLevel(rom, n);
    lv.objects.at(-1)!.x ^= 1;
    saveLevel(rom, lv);
    kept(`saving level ${n.toString(16)}'s layer 1 data`, n);
  }
  // a level's data moving to free space: what read its old place and its pointer is dropped
  {
    const lv = loadLevel(rom, 0x106), a = lv.l1Addr;
    const pointer = new RomReads(rom); pointer.read(snesToPc(L1_PTRS + 0x106 * 3), 3);
    const pointerDeps = results.fp.deps(pointer);
    for (let i = 0; i < 40; i++) lv.objects.push({ uid: newUid(), num: 0x21, ext: 0, x: 0x10 + i, y: 0x10, size: 0 });
    saveLevel(rom, lv);
    check(loadLevel(rom, 0x106).l1Addr !== a, 'level 106 grown: its layer 1 data moves to free space');
    check(!results.fp.valid(pointerDeps), 'what read its pointer entry is dropped');
    kept('saving level 106 moved', 0x106);
  }
  // the title screen level's own data (layer 1, sprites, its BG tilemap as layer 2): the boot is stale
  {
    const t = title[0], name = t.toString(16);
    const stale = (what: string) => { const s = base(); check(s !== state, `a change of the title screen level ${name}'s ${what} makes the boot snapshot stale`); state = s; };
    const lv = loadLevel(rom, t);
    lv.objects.at(-1)!.x ^= 1;
    saveLevel(rom, lv);
    stale('layer 1 data');
    check(uses.missing(levels).length === levels.length, 'then every level is scanned again');
    const ls = loadLevel(rom, t), at = ls.sprAddr;
    ls.sprites[0].x ^= 1;
    saveLevel(rom, ls);
    check(ls.sprAddr === at, `level ${name} with a sprite moved is saved in place`);
    stale('sprite data');
    const lb = loadLevel(rom, t), bg = bgFromWram(emu.load(t).wram);
    check(!lb.layer2Objects, `level ${name}'s layer 2 is a BG tilemap`);
    bg[0] ^= 1;
    lb.bg = bg;
    saveLevel(rom, lb);
    const a = storedBgAddr(rom, t);
    check(!!a, `level ${name}'s BG tilemap is stored in free space`);
    stale('BG tilemap');
    // its stored data changed in place (the first chunk's value: a tile number of the low plane)
    rom.w8(a + 1, rom.r8(a + 1) ^ 1);
    stale('stored BG tilemap data');
  }
}

// a BG tilemap stored in free space is level data, recorded by byte (as the table of the banks it is in): storing
// another level's next to it keeps the uses of the levels showing it, saving it anew (freeing its old place) keeps
// the other level's
{
  for (const n of uses.missing(levels)) scan(n);
  emu.load(0x105);
  const boot = results.fp.deps(emu.snapshot!.reads);
  const kept = (what: string, level: number) => {
    const m = uses.missing(levels);
    check(m.length === 1 && m[0] === level, `${what}: only level ${level.toString(16)} is scanned again (${m.map((x) => x.toString(16))})`);
    check(results.fp.valid(boot), `${what}: what the boot read is unchanged`);
    for (const n of m) scan(n);
  };
  // where a level's stored BG tilemap lies (PC, up to its end mark)
  const stored = (n: number) => {
    const o = snesToPc(storedBgAddr(rom, n));
    return [o, o + bgDataSize(rom.data, o)];
  };
  // a level's BG tilemap with a tile changed, stored in free space
  const edit = (n: number, i: number) => {
    const bg = bgFromWram(emu.load(n).wram), lv = loadLevel(rom, n);
    bg[i] ^= 1;
    lv.bg = bg;
    saveLevel(rom, lv);
    check(!!storedBgAddr(rom, n), `level ${n.toString(16)}'s BG tilemap is stored in free space`);
  };
  const pages = ([o, end]: number[]) => [o >> PAGE_SHIFT, (end - 1) >> PAGE_SHIFT];
  edit(0x105, 1);
  kept('level 105\'s BG tilemap stored', 0x105);
  const [first, last] = pages(stored(0x105));
  emu.load(0x105);
  check(last > first && bytePages(rom).subarray(first, last + 1).every((b) => b === 1), `its pages (${first.toString(16)}-${last.toString(16)}) are recorded by byte`);
  edit(0x106, 1);
  check(pages(stored(0x106))[0] === last, `level 106's BG tilemap is stored on its last page (${stored(0x106)[0].toString(16)})`);
  kept('level 106\'s BG tilemap stored next to it', 0x106);
  // (its old place, freed, is on the page of level 106's)
  edit(0x105, 2);
  kept('level 105\'s BG tilemap saved anew', 0x105);
}

// pointer tables recorded no coarser than what they point to: a GFX file moved to free space (an LZ2 file grown
// when drawn in) or another level's own palette keeps the boot's results, the probes, the sprite images and the
// other levels' uses; results that show graphics follow the files' content through their input
{
  for (const n of uses.missing(levels)) scan(n);
  const lv105 = loadLevel(rom, 0x105), bg = lv105.layer2Pointer >> 16 === 0xff ? lv105.layer2Pointer : 0xffd900;
  const images = results.fp.deps(emu.record('picture', () => captureSprites(emu, { number: 0x105, header: lv105.header, spriteHeader: lv105.spriteHeader, bgPointer: bg }, [0x04, 0x05, 0x0d])).reads);
  const host = new ProbeHost(), probes = new Map<string, RomDeps>();
  const jobs: ProbeJob[] = [{ kind: 'block', ts: 0, tile: 0x130 }, { kind: 'block', ts: 0, tile: 0x12b }, { kind: 'sprite', ts: 0, num: 0x04 }];
  host.setRom(rom.gen, rom.data.slice());
  host.ask(jobs);
  while (host.pending) { const d = host.next(); if (d?.type === 'probe') for (const [k, e] of d.put) probes.set(k, e.deps); }
  emu.load(0x105);
  const boot = results.fp.deps(emu.snapshot!.reads);
  const kept = (what: string, dropped: number[]) => {
    const m = uses.missing(levels);
    check(m.join() === dropped.join(), `${what}: ${dropped.length ? `only level ${dropped.map((x) => x.toString(16))}` : 'no level'} is scanned again (${m.map((x) => x.toString(16))})`);
    check(results.fp.valid(boot), `${what}: what the boot read is unchanged`);
    check(results.fp.valid(images), `${what}: the sprite images are kept`);
    check(jobs.every((j) => probes.has(jobKey(j))) && [...probes.values()].every((d) => results.fp.valid(d)), `${what}: the block and sprite probes are kept`);
    for (const n of m) scan(n);
  };
  // the GFX files the title screen loads (a render, which shows them, depends on their pointer entries)
  const p = editorPatch(rom)!, title = emu.record('title screen', () => null).reads;
  const slots = levelSlots(rom, 0x105, lv105.header), files = layerSlots(slots).map((s) => s.file), sprites = slots.filter((s) => s.sprite).map((s) => s.file);
  for (const f of [0x14, 0x00]) {
    const gfx = `GFX${f.toString(16).padStart(2, '0')}`;
    check(title.bytes.has(snesToPc(p.gfxLo + f)), `the boot loads ${gfx}`);
    const thumbs = JSON.stringify(thumbsInput(rom, lv105)), spriteHash = gfxFilesHash(rom, sprites), own = gfxFilesHash(rom, [f]);
    const g = readGfx(rom, f), a = g.addr;
    // (pixels drawn until the LZ2 data no longer fits its place)
    for (let i = 0; i < g.pix.length && g.addr === a; i += 37) { g.pix[i] = (g.pix[i] + 5) & 7; writeGfx(rom, g); }
    const name = `${gfx} drawn in and moved`;
    check(g.addr !== a, `${name} to free space`);
    kept(name, []);
    check(gfxFilesHash(rom, [f]) !== own, `${name}: what shows it is learned again`);
    check((JSON.stringify(thumbsInput(rom, lv105)) === thumbs) === !files.includes(f), `${name}: level 105's object thumbnails ${files.includes(f) ? 'are' : 'aren\'t'} learned again (its files: ${files.map((x) => x.toString(16))})`);
    check((gfxFilesHash(rom, sprites) === spriteHash) === !sprites.includes(f), `${name}: level 105's sprite images ${sprites.includes(f) ? 'are' : 'aren\'t'} learned again (its sprite files: ${sprites.map((x) => x.toString(16))})`);
  }
  // a GFX file moved but unchanged: nothing is learned again
  {
    const e = readGfx(rom, 0x14), hash = gfxFilesHash(rom, [0x14]);
    setGfxEntry(rom, 0x14, rom.allocWrite(rom.bytes(e.addr, e.packed)), false);
    check(gfxFilesHash(rom, [0x14]) === hash, 'GFX14 moved unchanged: what shows it is kept');
    kept('GFX14 moved unchanged', []);
  }
  // only a GFX file's flags changed: an uncompressed file whose bytes are also an LZ2 stream of the same length
  // (direct copies up to its last byte, the end mark) stored as LZ2 – the same bytes, stored another way
  {
    const data = new Uint8Array(0x1000).fill(0x55);
    for (let o = 0; o < data.length - 1;) {
      const n = Math.min(1024, data.length - 1 - o - 2);
      data[o] = 0xe0 | ((n - 1) >> 8); data[o + 1] = (n - 1) & 0xff;
      o += 2 + n;
    }
    data[data.length - 1] = 0xff;
    const addr = rom.allocWrite(data);
    setGfxEntry(rom, 0x81, addr, true);
    const slots = levelGfx(rom, 0x105);
    setLevelGfx(rom, 0x105, slots.map((s, k) => k === 0 || k === 7 ? 0x81 : s)); // in SP4 and FG1 of level 105
    const sprites = () => levelSlots(rom, 0x105, lv105.header).filter((s) => s.sprite).map((s) => s.file);
    const thumbs = JSON.stringify(thumbsInput(rom, lv105)), hash = gfxFilesHash(rom, sprites());
    setGfxEntry(rom, 0x81, addr, false);
    check(lz2Decompress(rom.data, snesToPc(addr)).size === data.length, 'GFX81 as LZ2: the same bytes');
    check(sprites().includes(0x81) && gfxFilesHash(rom, sprites()) !== hash, 'GFX81\'s flags changed: level 105\'s sprite images are learned again');
    check(JSON.stringify(thumbsInput(rom, lv105)) !== thumbs, 'GFX81\'s flags changed: level 105\'s object thumbnails are learned again');
    setLevelGfx(rom, 0x105, slots);
    setGfxEntry(rom, 0x81, 0, false);
  }
  // the levels' own palettes: their pointer table is recorded by byte
  const colors = new Uint8Array(0x200).fill(3);
  setCustomPalette(rom, 0x106, colors);
  kept('own palette of level 106 set', [0x106]);
  setCustomPalette(rom, 0x106, colors.map((c) => c ^ 1));
  kept('own palette of level 106 changed', [0x106]);
  setCustomPalette(rom, 0x106, null);
  kept('own palette of level 106 removed', [0x106]);
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

// a bank entry of the BG patch is a stored BG tilemap only behind a layer 2 pointer in bank $FF (the game reads layer 2
// objects for any other): one behind another pointer adds no level data range, saving the level with a BG pointer
// again drops it (else the game would read the new BG tilemap from its bank)
{
  const r = new Rom(rom.data.slice());
  const n = Array.from({ length: 0x200 }, (_, i) => i).find((i) => !hasLayer2Objects(loadLevel(r, i).header.mode) && !bgBank(r, i) && r.r24(L2_PTRS + i * 3) >> 16 === 0xff)!;
  const ptr = r.r24(L2_PTRS + n * 3), other = 0x0c0000 | (ptr & 0xffff);
  r.w24(L2_PTRS + n * 3, other);
  const ranges = JSON.stringify(levelDataRanges(r));
  setBgBank(r, n, spare >> 16);
  check(storedBgAddr(r, n) === 0, `level ${n.toString(16)} with a bank entry behind pointer ${other.toString(16)}: no stored BG tilemap`);
  check(JSON.stringify(levelDataRanges(r)) === ranges, 'and no level data range of one');
  const lv = loadLevel(r, n);
  lv.layer2Pointer = ptr;
  saveLevel(r, lv);
  check(bgBank(r, n) === 0 && storedBgAddr(r, n) === 0, `saved with pointer ${ptr.toString(16)} again: the bank entry is dropped`);
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
