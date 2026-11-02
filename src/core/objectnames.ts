// The names of level objects. Built in (a deliberate exception to learning everything by emulation, see
// docs/research/object-names-stability.md) only for the game's own numbers, which no tool or patch points at
// another object: standard objects 01–21; the tileset-specific 2E–3F per object table; extended objects 00, 01
// and 10–97. The free numbers (standard 22–2D, extended 02–0F and 98–FF) are "Object XX" / "Extended object XX",
// except the editor's own extended 04 and 05. Over them the names an installed package's Lunar Magic .mw0t gives
// extended objects (objtext.ts), over all of them the user's names of the project (usernames.ts).
// The names follow Lunar Magic's descriptions of the objects (FuSoYa).
//
// The object loader ($0DA415 in the clean game) runs standard objects through one of five tables of routines,
// picked by the tileset; which one a tileset uses is learned by emulation (objectTable), and the names of
// 2E–3F are keyed by the table's address.

import { pcToSnes, type Rom } from './rom.ts';
import type { RomReads } from './romdeps.ts';
import { L1_PTRS, serializeObjects, newUid, type LevelObject } from './level.ts';
import { OV_L1, readOffset, type LevelEmulator } from './levelemu.ts';
import { objectUserName } from './usernames.ts';
import { packageObjectName } from './objtext.ts';

export { setObjectUserName as setObjectName } from './usernames.ts'; // (key: objectNameKey; empty: the built-in name again)
import { hex2, hex } from './names.ts';

const STANDARD = `Water (blue)|Invisible coin blocks|Invisible note blocks|Invisible POW coins|Coins|Walk-through dirt|Water (other color)|Note blocks|Turn blocks|Coin ? blocks|Throw blocks|Black piranha plants|Cement blocks|Brown blocks|Vertical pipes|Horizontal pipes|Bullet shooter|Slopes|Ledge edges|Ground ledge|Midway/goal point|Blue coins|Rope/clouds|Water surface (animated)|Water surface (static)|Lava surface (animated)|Net top edge|Donut bridge|Net bottom edge|Net vertical edge|Vertical pipe/bone/log|Horizontal pipe/bone/log|Long ground ledge`.split('|');

// 2E–3F by the address of the object table (the clean game's; '' unused there): its routine and tilesets
const TILESET_OBJECTS: Record<number, string[]> = {
  // CODE_0DA44B: Normal 1, Normal 2, Cloud/Forest
  0x0da455: `||Ice-blue vertical pipe|Frozen turn block|Blue switch block|Forest tree top|Forest ledge edge|Forest ledge|Large tree trunk|Small tree trunk|Red switch block|Diagonal pipe (right)|Diagonal ledge (left)|Diagonal ledge (right)|Arch ledge|Cloud fringe (top)|Cloud fringe (side)|Bush`.split('|'),
  // CODE_0DC190: Castle 1
  0x0dc19a: `||||||Walk-through vertical pipe|Rock wall background|Large vertical spike|Horizontal line guide|Vertical line guide|Blue switch block|Red switch block|Castle ledge|Large stone block|Conveyor slope|Horizontal spikes|Vertical spikes`.split('|'),
  // CODE_0DCD90: Rope 1, Rope 2, Rope 3
  0x0dcd9a: `||||Log bridge|Blue switch block|Red switch block|Plant on a column|Conveyor ledge|Conveyor slope|Horizontal line guide|Vertical line guide|Sloped line guide|Steep sloped line guide|Mushroom ledge top|Mushroom ledge column|Horizontal log|Vertical log`.split('|'),
  // CODE_0DD990: Underground 1–3, Switch Palace 2, Castle 2
  0x0dd99a: `||||||Blue switch block|Red switch block|Edged ground square|Canvases|Mud/lava edge (right)|Mud/lava slope|Mud/lava with surface|Mud/lava|Very steep slope|Ceiling ledge|Solid ledge edge|Solid dirt`.split('|'),
  // CODE_0DE890: Switch Palace 1, Ghost House 1, Ghost House 2
  0x0de89a: `Thin upward spikes|Log background|Grassy ledge|Wooden crate|Grassy ledge 2|Ghost house cloud|Wooden ledge with column|Grey brick background|Wooden blocks|Log background/hand rail|Wooden ledge|Vertical log background|Brick edge/spikes|Ledge|Switch palace ceiling|Switch palace ledge|Switch palace edge (right)|Switch palace edge (left)`.split('|'),
};

// extended objects 10–97
const EXTENDED = `Small door|Invisible 1-Up ? block|Invisible note block (unused)|Top left corner edge|Top right corner edge|Small invisible POW door|Invisible POW ? block (coin)|Green star block (1-Up)|3-Up moon|Invisible 1-Up point 1|Invisible 1-Up point 2|Invisible 1-Up point 3|Invisible 1-Up point 4|Red berry|Pink berry|Green berry|Always-turning turn block|Midway point tile 1 (unused)|Midway point tile 2 (unused)|Note block (flower/feather/star)|ON/OFF block|? block (directional coins)|Note block|Note block (bounces on all sides)|Turn block (flower)|Turn block (feather)|Turn block (star)|Turn block (star 2/1-Up/vine)|Turn block (multiple coins)|Turn block (coin)|Turn block (nothing)|Turn block (POW)|? block (flower)|? block (feather)|? block (star)|? block (star 2)|? block (multiple coins)|? block (key/wings/balloon/shell)|? block (Yoshi)|? block (green shell)|? block (green shell) 2|Unbreakable turn block (feather)|Top left corner edge 2|Top right corner edge 2|Top left corner edge 3|Top right corner edge 3|Top left corner edge 4|Top right corner edge 4|Translucent block (changing item)|Yoshi coin|Top left slope|Top right slope|Purple triangle (left)|Purple triangle (right)|Midway point tape|Door|Invisible POW door|Ghost house exit|Climbing net door|Conveyor end 1|Conveyor end 2|Line guide, large circle top left|Line guide, large circle top right|Line guide, large circle bottom left|Line guide, large circle bottom right|Line guide, small circle top left|Line guide, small circle top right|Line guide, small circle bottom left|Line guide, small circle bottom right|Line guide end (horizontal)|Line guide end (vertical)|Switch palace corner, bottom right|Switch palace corner, bottom left|Switch palace corner, top right|Switch palace corner, top left|Brick background 1|Brick background 2|Brick background 3|Brick background 4|Large background area|Mud/lava steep corner, top right|Ghost house clock|Ghost house beam 1 (\\)|Ghost house beam 1 (/)|Ghost house cobweb, top right|Ghost house cobweb, top left|Ghost house beam 2 (/)|Ghost house beam 2 (\\)|Cloud fringe, bottom and right|Cloud fringe, bottom and left|Cloud fringe, bottom right|Cloud fringe, bottom left|Cloud fringe on white, bottom and right|Cloud fringe on white, bottom and left|Cloud fringe on white, bottom right|Cloud fringe on white, bottom left|Bit of canvas 1|Canvas 1|Canvas 2|Canvas 3|Canvas 4|Canvas tile 1|Canvas tile 2|Canvas tile 3|Canvas tile 4|Canvas tile 5|Canvas tile 6|Canvas tile 7|Bit of canvas 2|Bit of canvas 3|Bit of canvas 4|Torpedo launcher (skull)|Ghost house entrance|Water weed (animated)|Large bush|Mid-sized bush|Castle entrance|Yoshi's house|Goal arrow sign|Green switch block|Tree branch (left)|Tree branch (right)|Green switch palace switch|Yellow switch palace switch|Blue switch palace switch|Red switch palace switch|Yellow switch block|Ghost house window|Boss door|Steep slope (left)|Steep slope (right)|Steep normal slope (left)|Steep normal slope (right)|Very steep slope (left)|Very steep slope (right)|Switch palace edge, right and bottom`.split('|');

// the editor's own extended objects (patches.ts)
const EDITOR_EXTENDED: Record<number, string> = { 0x04: 'Prefab', 0x05: 'Direct Map16 (editor patch)' };

// The object table the object loader uses for objects in tileset ts: the SNES address of the entry of
// object 01 (in the slow banks, as the game's tables are known), null when not found. A level of that tileset with objects 01–0D is loaded; the table is where the
// load reads object n's entry at 3 × (n − 1) bytes from it (the same address for all of them).
const PROBE_LEVEL = 0x105; // the level loaded (its own objects and sprites left out)
const PROBE_OBJECTS = 13; // 01–0D: one routine of the game for all of them, which does not crash on size 0

export function objectTable(emu: LevelEmulator, ts: number): { result: number | null; reads: RomReads } {
  const rom = emu.rom;
  const h = rom.bytes(rom.r24(L1_PTRS + PROBE_LEVEL * 3), 5);
  const objs: LevelObject[] = Array.from({ length: PROBE_OBJECTS }, (_, i) => ({ uid: newUid(), num: i + 1, ext: 0, size: 0, x: i * 16 + 4, y: 0x10 }));
  const owners = [-1, -1, -1, -1, -1];
  const body = serializeObjects(objs, [], false, owners);
  const layer1 = new Uint8Array(5 + body.length);
  layer1.set([(h[0] & 0xe0) | 0x0f, h[1] & 0xe0, h[2], h[3], (h[4] & 0xf0) | ts]); // 16 screens, horizontal
  layer1.set(body, 5);
  const byteOwner = new Int32Array(0x10000).fill(-1);
  owners.forEach((o, i) => (byteOwner[OV_L1 + i] = o));
  return emu.tracked(() => {
    const r = emu.load(PROBE_LEVEL, { layer1, sprites: Uint8Array.of(0, 0xff), byteOwner, trace: true });
    // per object the ROM offsets it read, less 3 × (n − 1): the table's start is in all of them
    const starts = Array.from({ length: PROBE_OBJECTS }, (_, i) => new Set([...r.trace?.reads.get(i) ?? []].map((v) => readOffset(v) - 3 * i)));
    const common = [...starts[0]].filter((o) => starts.every((s) => s.has(o)));
    return common.length ? pcToSnes(Math.min(...common)) & 0x7fffff : null;
  });
}

// the built-in name of an object (num 0: extended object ext; table: of the level's tileset, objectTable), null
// for the free numbers
export function builtinObjectName(num: number, ext: number, table: number | null): string | null {
  if (num === 0) return ext === 0 ? 'Screen exit' : ext === 1 ? 'Screen jump' : EDITOR_EXTENDED[ext] ?? EXTENDED[ext - 0x10] ?? null;
  if (num < 0x2e) return STANDARD[num - 1] ?? null;
  return (table !== null && TILESET_OBJECTS[table]?.[num - 0x2e]) || null;
}

// whether an object's name depends on the object table (the tileset-specific objects 2E–3F)
export function namedPerTable(num: number): boolean {
  return num >= 0x2e;
}

// where the user's name of an object is kept: 2E–3F per object table (null while the table is unknown: no
// name of the user then), the others per number
export function objectNameKey(num: number, ext: number, table: number | null): string | null {
  if (num === 0) return `x${hex2(ext)}`;
  if (!namedPerTable(num)) return `s${hex2(num)}`;
  return table === null ? null : `s${hex2(num)}@${hex(table, 6)}`;
}

// the name of an object without one: by its number
export function numberName(num: number, ext: number): string {
  return num === 0 ? `Extended object ${hex2(ext)}` : `Object ${hex2(num)}`;
}

// the name without the user's: the built-in one, else by number
export function defaultObjectName(num: number, ext: number, table: number | null): string {
  return builtinObjectName(num, ext, table) ?? numberName(num, ext);
}

// the name without the user's in this ROM: a package's (.mw0t, extended objects), else the default one
export function baseObjectName(rom: Rom, num: number, ext: number, table: number | null): string {
  return (num === 0 ? packageObjectName(rom, ext) : null) ?? defaultObjectName(num, ext, table);
}

// the name shown: the user's, else the base one
export function objectName(rom: Rom, num: number, ext: number, table: number | null): string {
  const key = objectNameKey(num, ext, table);
  return (key !== null ? objectUserName(rom, key) : null) ?? baseObjectName(rom, num, ext, table);
}
