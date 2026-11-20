// The overworld's start positions, sprite slots and Koopa Kid places (owsprites.ts). Checked on the model – the clean
// game's read and written back unchanged – and by emulation: a new game starts at the set positions (Mario and
// Luigi), a slot moved or given another sprite is there when the overworld loads, and its image (learned from the
// game's OAM) is drawn where it is.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { RomReads } from '../src/core/romdeps.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { OverworldEmulator, OverworldLoads } from '../src/core/overworld.ts';
import {
  readStart, writeStart, readOwSprites, readOwSprite, writeOwSprite, koopaKidPos, setKoopaKidPos, owSpriteImages, OW_SPRITE_SLOTS, OW_SPRITES, KOOPA_KIDS,
} from '../src/core/owsprites.ts';
import { RAM, get16 } from '../src/core/ram.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { editorPatch } from '../src/core/patches.ts';
import { editorImage, romDiff } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();

const rom = new Rom(await editorImage());

// ---- the clean game's ----
{
  const mario = readStart(rom, 0), luigi = readStart(rom, 1), sprites = readOwSprites(rom);
  check(JSON.stringify(mario) === JSON.stringify({ submap: 1, x: 6, y: 7 }) && JSON.stringify(luigi) === JSON.stringify(mario), `start: Mario and Luigi on Yoshi's Island 06,07 (${JSON.stringify(mario)})`);
  check(sprites.length === OW_SPRITE_SLOTS && sprites.filter((s) => s.num).length === 8 && sprites[2].num === 6 && sprites[2].x === 0x170 && sprites[2].y === 0x20,
    `13 slots, 8 used: ${sprites.map((s) => `${hx(s.num)}@${hx(s.x)},${hx(s.y)}`).join(' ')}`);
  const r = new Rom(rom.data.slice());
  writeStart(r, 0, mario); writeStart(r, 1, luigi);
  sprites.forEach((s, k) => writeOwSprite(r, k, s));
  for (let k = 0; k < KOOPA_KIDS; k++) setKoopaKidPos(r, k, koopaKidPos(rom, k));
  check(romDiff(rom.data, r.data) === 0, 'written back unchanged');
}

// ---- a new game ----
{
  const r = new Rom(rom.data.slice());
  writeStart(r, 0, { submap: 0, x: 0x0c, y: 0x09 });
  writeStart(r, 1, { submap: 2, x: 5, y: 0x14 });
  const e = new LevelEmulator(r);
  e.startGame(0);
  const w = e.snes.wram, at = (o: number) => `${w[RAM.submap + o / 4]}:${hx(get16(w, RAM.owPlayerX + o))},${hx(get16(w, RAM.owPlayerY + o))} ${hx(get16(w, RAM.owPlayerTileX + o))},${hx(get16(w, RAM.owPlayerTileY + o))}`;
  check(at(0) === '0:C8,98 C,9' && at(4) === '2:58,148 5,14', `a new game: Mario ${at(0)}, Luigi ${at(4)}`);
}

// ---- sprites where set ----
{
  const r = new Rom(rom.data.slice()), emu = new OverworldEmulator(r), loads = new OverworldLoads(emu, 4);
  const before = owSpriteImages(new OverworldLoads(new OverworldEmulator(rom), 4), 0, 0);
  const shown = before.map((v, k) => (v.image ? k : -1)).filter((k) => k >= 0);
  check(shown.length >= 3, `the main map shows slots ${shown.join(', ')}`);
  // the Boos (slot 10) moved and slot 9 (Cheep Cheep) made Boos too
  const boo = readOwSprite(rom, 10);
  writeOwSprite(r, 10, { ...boo, x: boo.x + 0x40, y: boo.y - 0x18 });
  writeOwSprite(r, 9, { num: boo.num, x: 0x100, y: 0x100 });
  const w = emu.load(0, 0).wram;
  const slot = (k: number) => ({ num: w[RAM.owSpriteNum + 3 + k], x: w[RAM.owSpriteXLo + 3 + k] | (w[RAM.owSpriteXHi + 3 + k] << 8), y: w[RAM.owSpriteYLo + 3 + k] | (w[RAM.owSpriteYHi + 3 + k] << 8) });
  check(JSON.stringify(slot(10)) === JSON.stringify({ ...boo, x: boo.x + 0x40, y: boo.y - 0x18 }) && JSON.stringify(slot(9)) === JSON.stringify({ num: boo.num, x: 0x100, y: 0x100 }),
    `loaded where set: slot 10 ${JSON.stringify(slot(10))}, slot 9 ${JSON.stringify(slot(9))}`);
  const after = owSpriteImages(loads, 0, 0);
  const near = (k: number, x: number, y: number) => { const i = after[k].image; return !!i && Math.abs(i.ox + i.w / 2 - x) < 24 && Math.abs(i.oy + i.h / 2 - y) < 24; };
  const b0 = before[10].image!, moved = after[10].image;
  check(!!moved && moved.ox - b0.ox === 0x40 && moved.oy - b0.oy === -0x18, `slot 10 drawn moved by 40,-18 (${moved && `${hx(moved.ox)},${hx(moved.oy)}`} from ${hx(b0.ox)},${hx(b0.oy)})`);
  check(near(9, 0x100, 0x100), `slot 9 drawn as Boos at 100,100 (${after[9].image && `${hx(after[9].image.ox)},${hx(after[9].image.oy)} ${after[9].image.w}x${after[9].image.h}`})`);
}

// ---- from a kept load ----
// the images run on from the map's kept load: the same as from a load of their own; a load's console is saved when
// first asked for (taken right after the load, else loaded once more: another map loaded in between), then kept
{
  const emu = new OverworldEmulator(new Rom(rom.data.slice())), loads = new OverworldLoads(emu, 4);
  let loaded = 0;
  const loadRecorded = emu.loadRecorded.bind(emu);
  emu.loadRecorded = (map, progress) => { loaded++; return loadRecorded(map, progress); };
  const text = (vs: ReturnType<typeof owSpriteImages>) => JSON.stringify(vs.map((v) => v.image && { ox: v.image.ox, oy: v.image.oy, w: v.image.w, h: v.image.h, z: v.z, px: Array.from(v.image.rgba).join() }));
  for (const [map, progress] of [[0, 0], [0, 0x20], [1, 0]]) {
    const own = text(owSpriteImages(new OverworldLoads(new OverworldEmulator(new Rom(rom.data.slice())), 1), map, progress));
    loads.get(map, progress);
    emu.load(map ? 0 : 2, 0); // (another map on the console)
    loaded = 0;
    const kept = text(owSpriteImages(loads, map, progress));
    check(kept === own && loaded === 1, `map ${map} at progress ${hx(progress)}: the kept load's images the same as its own load's, ${loaded} loads (its console not kept)`);
    emu.load(map ? 0 : 2, 0);
    loaded = 0;
    loads.restore(map, progress);
    check(loaded === 0, `map ${map} at progress ${hx(progress)}: its console kept once asked for, ${loaded} loads`);
  }
  loads.get(3, 0);
  loaded = 0;
  loads.restore(3, 0);
  check(loaded === 0, `right after a load: its console taken without loading again, ${loaded} loads`);
}

// ---- kept while what they read stays ----
// the images are kept while the ROM edits since changed no byte the frames read (a level's graphics), made again for
// an edit of a slot
{
  const r = new Rom(rom.data.slice()), s = new RomEditSession(r), emu = new OverworldEmulator(r), loads = new OverworldLoads(emu, 4);
  let loaded = 0;
  const loadRecorded = emu.loadRecorded.bind(emu);
  emu.loadRecorded = (map, progress) => { loaded++; return loadRecorded(map, progress); };
  const v = owSpriteImages(loads, 0, 0);
  loaded = 0;
  check(owSpriteImages(loads, 0, 0) === v && loaded === 0, 'asked again: the kept images, no load');
  const gfx = editorPatch(r)!.levelGfx + 0x105 * 8;
  s.edit('Level 105 graphics', () => r.w8(gfx, r.r8(gfx) ^ 1));
  check(owSpriteImages(loads, 0, 0) === v && loaded === 0, `a ROM edit the frames didn't read: the kept images, ${loaded} loads`);
  const outer = new RomReads(r);
  emu.snes.romReads = outer;
  owSpriteImages(loads, 0, 0);
  emu.snes.romReads = null;
  check(outer.bytes.has(snesToPc(OW_SPRITES)), 'kept images: their reads count for an outer recorder (the slot table)');
  const boo = readOwSprite(r, 10);
  s.edit('Overworld sprite 11: moved', () => writeOwSprite(r, 10, { ...boo, x: boo.x + 0x10 }));
  const v2 = owSpriteImages(loads, 0, 0);
  check(v2 !== v && v2[10].image!.ox - v[10].image!.ox === 0x10, 'a slot moved: made again, the slot drawn moved');
  const v3 = owSpriteImages(loads, 1, 0);
  check(v3 !== v2 && owSpriteImages(loads, 0, 0) !== v2, 'another map: made for it, the first map\'s made again (one kept)');
}

// ---- not read by what plays a level ----
// the boot runs the slots' loader on the title screen (nothing of it shown): the table isn't among the boot's reads,
// so a level load (every block, sprite and path probe starts from the boot) doesn't depend on it; an edit of a slot
// keeps the boot snapshot, and a level loads from it as on a ROM booted with the slot (WRAM from $1000: below are the
// title screen's leftovers, OAM tiles off the screen and the overworld sprites' RAM)
{
  const r = new Rom(rom.data.slice()), emu = new LevelEmulator(r), lo = snesToPc(OW_SPRITES), hi = lo + OW_SPRITE_SLOTS * 5;
  const inTable = (reads: RomReads) => [...reads.bytes].filter((o) => o >= lo && o < hi).length;
  emu.boot();
  check(inTable(emu.snapshot!.reads) === 0, `the boot: no byte of the slot table read (${inTable(emu.snapshot!.reads)})`);
  const reads = emu.record('full picture', () => emu.load(0x105)).reads;
  check(inTable(reads) === 0, `a level load: no byte of the slot table read (${inTable(reads)})`);
  const boot = emu.snapshot;
  const boo = readOwSprite(r, 10);
  writeOwSprite(r, 10, { ...boo, num: 1, x: boo.x + 0x30 });
  const kept = emu.load(0x105), fresh = new LevelEmulator(new Rom(r.data.slice())).load(0x105);
  check(emu.snapshot === boot && Buffer.compare(kept.vram, fresh.vram) === 0 && Buffer.compare(kept.wram.subarray(0x1000), fresh.wram.subarray(0x1000)) === 0,
    'a slot edited: the boot snapshot kept, level 105 loads as on a ROM booted with the slot');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
