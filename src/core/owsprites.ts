// The overworld's start positions and the game's overworld sprites, in place as the game keeps them (as Lunar
// Magic edits them):
// - the start positions of a new game ($009EF0, 22 bytes the new file copies to $1F11–$1F26): per player the
//   submap, the pixel position (Mario on a tile at its 16x16 block's +8,+8) and the tile
// - 13 sprite slots ($04F625, 5 bytes each: the sprite, pixel X, pixel Y; loaded into slots 3–15 at $04F678 when
//   the overworld loads), the same on every submap: each sprite's own code decides where it shows
// - where the Koopa Kids jump out when Mario stands on their tiles 49–4B ($04FB88 X low, $04FB8B X high, $04FB8E
//   Y low, $04FB91 Y high; the tile checked at $04FBA1)
// What the sprites look like at an event progress is learned by emulation (owSpriteImages): the overworld loaded,
// each slot shown alone with the camera on it (on the main map it follows Mario), its OAM tiles those the game adds.
// With BOWSIE installed (owcustom.ts) its loader has taken the place of the slots' table and load: there are none.
// With BOWSIE's MaxTile its code is where the Koopa Kids' table was: there is none (they don't jump out).
// The custom sprites (BOWSIE's, Lunar Magic's table) are drawn the same way (customSpriteImages, customSpriteLooks).

import type { Rom } from './rom.ts';
import { loadKey, type OverworldLoads } from './overworld.ts';
import type { Job } from './jobrunner.ts';
import type { EventProgress } from './eventset.ts';
import { OwRefusal } from './owrefusal.ts';
import { RAM, set16, getS16 } from './ram.ts';
import { readPpuOam, drawTiles, tileKey, type SpriteImage } from './spritegfx.ts';
import { bowsieInstalled, bowsieMaxTile, readCustomSprites, customEntryAddrs, type CustomOwSprite } from './owcustom.ts';

export const START = 0x009ef0;
const START_X = 6, START_Y = 8, START_TX = 0x0e, START_TY = 0x10; // offsets of player 1's words, player 2's + 4
export const OW_SPRITES = 0x04f625, OW_SPRITE_SLOTS = 13;
export const KOOPA_KID = { xlo: 0x04fb88, xhi: 0x04fb8b, ylo: 0x04fb8e, yhi: 0x04fb91 };
export const KOOPA_KIDS = 3;
const FIRST_SLOT = 3; // the RAM slot of the table's first sprite
// the game's overworld sprites (00 none)
export const OW_SPRITE_NAMES = ['None', 'Lakitu', 'Blue bird', 'Cheep Cheep', 'Piranha Plant', 'Cloud', 'Koopa Kid', 'Smoke', 'Bowser sign', 'Bowser', 'Boos'];

// ---- start positions ----
export interface StartPos { submap: number; x: number; y: number } // a tile
export function readStart(rom: Rom, player: number): StartPos {
  return { submap: rom.r8(START + player), x: rom.r16(START + START_TX + player * 4), y: rom.r16(START + START_TY + player * 4) };
}
export function writeStart(rom: Rom, player: number, p: StartPos): void {
  rom.w8(START + player, p.submap);
  rom.w16(START + START_X + player * 4, p.x * 16 + 8);
  rom.w16(START + START_Y + player * 4, p.y * 16 + 8);
  rom.w16(START + START_TX + player * 4, p.x);
  rom.w16(START + START_TY + player * 4, p.y);
}

// ---- sprite slots ----
export interface OwSprite { num: number; x: number; y: number } // pixels
export function readOwSprite(rom: Rom, k: number): OwSprite {
  const a = OW_SPRITES + k * 5;
  return { num: rom.r8(a), x: rom.r16(a + 1), y: rom.r16(a + 3) };
}
export function writeOwSprite(rom: Rom, k: number, s: OwSprite): void {
  const a = OW_SPRITES + k * 5;
  rom.writeBytes(a, Uint8Array.of(s.num, s.x & 0xff, (s.x >> 8) & 0xff, s.y & 0xff, (s.y >> 8) & 0xff));
}
export const readOwSprites = (rom: Rom): OwSprite[] => Array.from({ length: OW_SPRITE_SLOTS }, (_, k) => readOwSprite(rom, k));
// the game's sprite slots are there (not with BOWSIE, whose code is where their table was)
export const hasOwSpriteSlots = (rom: Rom): boolean => !bowsieInstalled(rom);

// ---- Koopa Kids ----
// the Koopa Kids' table is there (not with BOWSIE's MaxTile, whose code is where it was)
export const hasKoopaKidTable = (rom: Rom): boolean => !bowsieMaxTile(rom);
export function koopaKidPos(rom: Rom, k: number): { x: number; y: number } {
  return { x: rom.r8(KOOPA_KID.xlo + k) | (rom.r8(KOOPA_KID.xhi + k) << 8), y: rom.r8(KOOPA_KID.ylo + k) | (rom.r8(KOOPA_KID.yhi + k) << 8) };
}
export function setKoopaKidPos(rom: Rom, k: number, p: { x: number; y: number }): void {
  if (!hasKoopaKidTable(rom)) throw new OwRefusal({ kind: 'koopaTableBowsie' });
  rom.w8(KOOPA_KID.xlo + k, p.x & 0xff); rom.w8(KOOPA_KID.xhi + k, (p.x >> 8) & 0xff);
  rom.w8(KOOPA_KID.ylo + k, p.y & 0xff); rom.w8(KOOPA_KID.yhi + k, (p.y >> 8) & 0xff);
}

// ---- by emulation ----
// a slot as the game shows it: its image (ox/oy its top-left on the map, pixels; null: not shown there) and its
// height above its position ($0E55)
export interface OwSpriteView { image: SpriteImage | null; z: number }
const SHOW_FRAMES = 3;
// every slot of map `map` at event progress `progress`, as the game shows it (run on from the kept load); kept for
// one map and progress while the ROM edits since changed no byte it read (OverworldLoads.derive)
export function owSpriteImages(loads: OverworldLoads, map: number, progress: EventProgress): OwSpriteView[] {
  return loads.derive('owSpriteImages', () => runSprites(loads, map, progress), loadKey(map, progress));
}
// owSpriteImages as a job of the result learner (probe worker), one step (overworldMapJob)
export function* owSpritesJob(loads: OverworldLoads, map: number, progress: EventProgress): Job<OwSpriteView[]> {
  return owSpriteImages(loads, map, progress);
}
function runSprites(loads: OverworldLoads, map: number, progress: EventProgress): OwSpriteView[] {
  if (!hasOwSpriteSlots(loads.emu.rom)) return [];
  loads.restore(map, progress);
  const emu = loads.emu, s = emu.snes, w = s.wram, start = s.saveState(), sprites = readOwSprites(emu.rom);
  const nums = (keep: number) => { for (let k = 0; k < OW_SPRITE_SLOTS; k++) if (k !== keep) w[RAM.owSpriteNum + FIRST_SLOT + k] = 0; };
  // the frames with slot `keep` (-1 none) and the camera on (x, y) on the main map: the OAM tiles on the map; without
  // a slot on a submap (its camera doesn't move) once
  let bare: ReturnType<typeof run> | null = null;
  const show = (keep: number, x: number, y: number) => (keep < 0 && map ? (bare ??= run(keep, x, y)) : run(keep, x, y));
  const run = (keep: number, x: number, y: number) => {
    s.loadState(start);
    nums(keep);
    if (!map) { set16(w, RAM.owPlayerX, x); set16(w, RAM.owPlayerY, y); }
    for (let f = 0; f < SHOW_FRAMES; f++) s.runFrame();
    return { tiles: readPpuOam(s.oam), cx: getS16(w, RAM.layer1X), cy: getS16(w, RAM.layer1Y), z: w[RAM.owSpriteZ + FIRST_SLOT + keep] };
  };
  return sprites.map((sp, k) => {
    if (!sp.num) return { image: null, z: 0 };
    const base = new Set(show(-1, sp.x, sp.y).tiles.map(tileKey)), on = show(k, sp.x, sp.y);
    const img = drawTiles(s, on.tiles.filter((t) => !base.has(tileKey(t))));
    return { image: img && { ...img, ox: img.ox + on.cx, oy: img.oy + on.cy }, z: on.z };
  });
}

// ---- custom sprites (BOWSIE) by emulation ----
// Each shown alone on the map loaded at the progress: BOWSIE's slots emptied (as its clear_ram), the sprite put in
// the first as its loader spawns one (number, pixel position and height, the first 4 extra bytes or, with more, the
// address of its entry's extra bytes) and the camera on it (on the main map Mario put there); its own init and main
// code then draw it, its image the OAM tiles it adds. Without BOWSIE none is shown.
interface CustomRun { s: CustomOwSprite; extraAt: number }
function runCustom(loads: OverworldLoads, map: number, progress: EventProgress, sprites: CustomRun[]): OwSpriteView[] {
  if (!bowsieInstalled(loads.emu.rom) || !sprites.length) return sprites.map((r) => ({ image: null, z: r.s.z * 8 }));
  loads.restore(map, progress);
  const emu = loads.emu, s = emu.snes, w = s.wram, start = s.saveState();
  const clear = () => { w.fill(0, RAM.bowsieNum, RAM.bowsieTablesEnd); w.fill(0, RAM.bowsieExtra1, RAM.bowsieExtra1 + RAM.bowsieExtraLen); w.fill(0, RAM.bowsieExtra2, RAM.bowsieExtra2 + RAM.bowsieExtraLen); };
  const run = (one: CustomRun | null, x: number, y: number) => {
    s.loadState(start);
    clear();
    if (one) {
      const { s: sp, extraAt } = one, e = sp.extra;
      set16(w, RAM.bowsieNum, sp.id); set16(w, RAM.bowsieX, sp.x * 8); set16(w, RAM.bowsieY, sp.y * 8); set16(w, RAM.bowsieZ, sp.z * 8);
      if (e.length > 4) { set16(w, RAM.bowsieExtra1, extraAt & 0xffff); set16(w, RAM.bowsieExtra2, extraAt >> 16); }
      else { w[RAM.bowsieExtra1] = e[0] ?? 0; w[RAM.bowsieExtra1 + 1] = e[1] ?? 0; w[RAM.bowsieExtra2] = e[2] ?? 0; w[RAM.bowsieExtra2 + 1] = e[3] ?? 0; }
    }
    if (!map) { set16(w, RAM.owPlayerX, x); set16(w, RAM.owPlayerY, y); }
    for (let f = 0; f < SHOW_FRAMES; f++) s.runFrame();
    return { tiles: readPpuOam(s.oam), cx: getS16(w, RAM.layer1X), cy: getS16(w, RAM.layer1Y) };
  };
  let bare: ReturnType<typeof run> | null = null;
  return sprites.map((one) => {
    const x = one.s.x * 8, y = one.s.y * 8;
    const base = new Set((map ? (bare ??= run(null, x, y)) : run(null, x, y)).tiles.map(tileKey)), on = run(one, x, y);
    const img = drawTiles(s, on.tiles.filter((t) => !base.has(tileKey(t))));
    return { image: img && { ...img, ox: img.ox + on.cx, oy: img.oy + on.cy }, z: one.s.z * 8 };
  });
}
// the custom sprites of map `map` (its list in Lunar Magic's table) as the game shows them at event progress
// `progress`, in the list's order; kept as owSpriteImages
export function customSpriteImages(loads: OverworldLoads, map: number, progress: EventProgress): OwSpriteView[] {
  return loads.derive('customSpriteImages', () => {
    const rom = loads.emu.rom, list = readCustomSprites(rom)[map] ?? [], at = customEntryAddrs(rom, map);
    return runCustom(loads, map, progress, list.map((s, k) => ({ s, extraAt: (at[k] ?? 0) + 3 })));
  }, loadKey(map, progress));
}
export function* owCustomJob(loads: OverworldLoads, map: number, progress: EventProgress): Job<OwSpriteView[]> {
  return customSpriteImages(loads, map, progress);
}
// how custom sprites `ids` look (the palette): each alone on the main map before any event, its extra bytes 0,
// spawned at LOOK_AT (8px steps); the image's offset is from the sprite's position
const LOOK_AT = 0x20, LOOK_PX = LOOK_AT * 8;
export function customSpriteLooks(loads: OverworldLoads, ids: number[]): (SpriteImage | null)[] {
  return loads.derive('customSpriteLooks', () => runCustom(loads, 0, 0, ids.map((id) => ({ s: { id, x: LOOK_AT, y: LOOK_AT, z: 0, extra: [] }, extraAt: 0 })))
    .map((v) => v.image && { ...v.image, ox: v.image.ox - LOOK_PX, oy: v.image.oy - LOOK_PX }), ids.join(','));
}
export function* owLooksJob(loads: OverworldLoads, ids: number[]): Job<(SpriteImage | null)[]> {
  return customSpriteLooks(loads, ids);
}
