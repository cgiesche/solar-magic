// Custom overworld sprites in Lunar Magic's table (2.50's, help `info_custom_ov_sprite.htm`), which BOWSIE (Arinsu)
// reads when the overworld loads and when Mario walks to another submap:
// - a 24-bit pointer at $0EF55D to the table (0 or $FFFFFF: none), kept in a RATS block as Lunar Magic does
// - the table: 7 word offsets from its start, one per submap, each to its list; a list ends with `dw 0`; up to 0x18
//   sprites a submap
// - an entry: the sprite (01–7F), X and Y in 8px steps (0–3F, on the submap's 512x512 pixels), its height (0–1F,
//   8px steps), packed as `nxxxxxxx`: id | (x & 1) << 7, then (x >> 1) | (y & 7) << 5, then (y >> 3) | z << 3; then
//   its extra bytes
// - the entry's size (3.51's size table, help `info_custom_ov_sprite_size.htm`): 0x7F bytes, the first for sprite 1,
//   at the 24-bit pointer $0DE18C, used when $0DE18F is $42 (BOWSIE writes it with its sprites' extra bytes); else 4
//   (one extra byte). Sizes 3–0xF.

import { snesToPc, type Rom } from './rom.ts';

export const OW_CUSTOM_PTR = 0x0ef55d;
export const OW_CUSTOM_SIZES = 0x0de18c; // pointer, then $42 at +3 when used
export const OW_CUSTOM_SUBMAPS = 7;
export const OW_CUSTOM_MAX = 0x18; // sprites a submap
export const OW_CUSTOM_IDS = 0x7f; // sprites 01–7F
export const OW_CUSTOM_POS_MAX = 0x3f; // X and Y, 8px steps
export const OW_CUSTOM_Z_MAX = 0x1f; // height, 8px steps
const DEFAULT_SIZE = 4, MIN_SIZE = 3, MAX_SIZE = 0x0f;

// a sprite on a submap: x, y and z in 8px steps; extra: its extra bytes (as many as its size takes)
export interface CustomOwSprite { id: number; x: number; y: number; z: number; extra: number[] }

// the size table (0x7F bytes, sprite 1 first), null when not used
export function customSizeTable(rom: Rom): Uint8Array | null {
  if (rom.r8(OW_CUSTOM_SIZES + 3) !== 0x42) return null;
  return rom.bytes(rom.r24(OW_CUSTOM_SIZES), OW_CUSTOM_IDS);
}
// the bytes an entry of sprite `id` takes
export function customEntrySize(sizes: Uint8Array | null, id: number): number {
  if (!sizes) return DEFAULT_SIZE;
  const n = sizes[(id - 1) & 0x7f] ?? DEFAULT_SIZE;
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, n));
}
export const customExtraBytes = (sizes: Uint8Array | null, id: number): number => customEntrySize(sizes, id) - 3;

// the table's address, null when there is none
export function customTable(rom: Rom): number | null {
  const p = rom.r24(OW_CUSTOM_PTR);
  if (p === 0 || p === 0xffffff) return null;
  const pc = snesToPc(p);
  return pc >= 0 && pc < rom.data.length ? p : null;
}

function decode(rom: Rom, at: number, sizes: Uint8Array | null): { sprites: CustomOwSprite[]; end: number } {
  const out: CustomOwSprite[] = [];
  let a = at;
  for (let guard = 0; guard < 0x100; guard++) {
    if (rom.r16(a) === 0) return { sprites: out, end: a + 2 };
    const [b0, b1, b2] = rom.bytes(a, 3), id = b0 & 0x7f, n = customEntrySize(sizes, id);
    out.push({ id, x: (b0 >> 7) | ((b1 & 0x1f) << 1), y: (b1 >> 5) | ((b2 & 7) << 3), z: b2 >> 3, extra: [...rom.bytes(a + 3, n - 3)] });
    a += n;
  }
  throw new Error('The custom overworld sprite table has no end');
}

// the sprites of every submap (7 lists), as the sizes give them (by default the ROM's)
export function readCustomSprites(rom: Rom, sizes = customSizeTable(rom)): CustomOwSprite[][] {
  const t = customTable(rom);
  if (t === null) return Array.from({ length: OW_CUSTOM_SUBMAPS }, () => []);
  return Array.from({ length: OW_CUSTOM_SUBMAPS }, (_, m) => decode(rom, t + rom.r16(t + m * 2), sizes).sprites);
}

// the table's bytes for the lists (each entry the size the sizes give it: extra bytes cut or padded with 0)
export function customTableBytes(lists: CustomOwSprite[][], sizes: Uint8Array | null): Uint8Array {
  const body: number[][] = lists.map((l) => {
    const out: number[] = [];
    for (const s of l) {
      const n = customEntrySize(sizes, s.id);
      out.push((s.id & 0x7f) | ((s.x & 1) << 7), ((s.x >> 1) & 0x1f) | ((s.y & 7) << 5), ((s.y >> 3) & 7) | ((s.z & 0x1f) << 3));
      for (let k = 0; k < n - 3; k++) out.push((s.extra[k] ?? 0) & 0xff);
    }
    out.push(0, 0);
    return out;
  });
  const bytes: number[] = [];
  let off = OW_CUSTOM_SUBMAPS * 2;
  for (const b of body) { bytes.push(off & 0xff, off >> 8); off += b.length; }
  return Uint8Array.from([...bytes, ...body.flat()]);
}

// why the lists can't be written (Lunar Magic's limits), null when they can
export function customSpritesProblem(lists: CustomOwSprite[][]): string | null {
  if (lists.length !== OW_CUSTOM_SUBMAPS) return `${OW_CUSTOM_SUBMAPS} submaps expected`;
  for (const [m, l] of lists.entries()) {
    if (l.length > OW_CUSTOM_MAX) return `At most ${OW_CUSTOM_MAX} custom sprites a submap (submap ${m} has ${l.length})`;
    for (const s of l) {
      if (s.id < 1 || s.id > OW_CUSTOM_IDS) return `Custom overworld sprites are 01–7F (${s.id.toString(16).toUpperCase()})`;
      if (s.x < 0 || s.y < 0 || s.x > OW_CUSTOM_POS_MAX || s.y > OW_CUSTOM_POS_MAX) return 'A custom overworld sprite is at most 3F,3F (8px steps)';
      if (s.z < 0 || s.z > OW_CUSTOM_Z_MAX) return 'A custom overworld sprite\'s height is at most 1F (8px steps)';
    }
  }
  return null;
}

// writes the lists to a new table (the old one freed); without sprites the pointer is 0 (none, as Lunar Magic reads
// it, and BOWSIE's loader stops at a bank of 0). Sizes: those to write with (by default the ROM's).
export function writeCustomSprites(rom: Rom, lists: CustomOwSprite[][], sizes = customSizeTable(rom)): void {
  const why = customSpritesProblem(lists);
  if (why) throw new Error(why);
  const old = customTable(rom);
  if (old !== null) rom.freeAt(old);
  rom.w24(OW_CUSTOM_PTR, lists.some((l) => l.length) ? rom.allocWrite(customTableBytes(lists, sizes)) : 0);
}

// the ROM bytes of the custom sprites (PC offsets, [start, end)): the pointer and the table
export function customSpriteRanges(rom: Rom): [number, number][] {
  const out: [number, number][] = [[snesToPc(OW_CUSTOM_PTR), snesToPc(OW_CUSTOM_PTR) + 3]];
  const t = customTable(rom);
  if (t === null) return out;
  try {
    const sizes = customSizeTable(rom);
    let end = t + OW_CUSTOM_SUBMAPS * 2;
    for (let m = 0; m < OW_CUSTOM_SUBMAPS; m++) end = Math.max(end, decode(rom, t + rom.r16(t + m * 2), sizes).end);
    out.push([snesToPc(t), snesToPc(t) + (end - t)]);
  } catch { /* a broken table: only its pointer */ }
  return out;
}
