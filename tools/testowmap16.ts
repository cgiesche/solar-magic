// The overworld's layer 1 tiles as a Map16 target: a tile's quarters read and written at $05D000 (8 bytes a tile, the
// one edit changes those bytes only, one undo step), the game draws the changed tile wherever layer 1 has it (emulated:
// the BG1 tilemap after the overworld's load), and the bytes are overworld data (a change restarts no result that
// leaves the overworld's data out).
import { Rom, snesToPc } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { OverworldEmulator, gameL1, l1Index, owTileWords, setOwTileWords, owTileAddr, overworldDataRanges, OW_L1_TILES, type OwRender } from '../src/core/overworld.ts';
import { map16Pointer } from '../src/core/ram.ts';
import { FLIP_X } from '../src/core/quarters.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const diff = (a: Uint8Array, b: Uint8Array) => { const out: number[] = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i); return out; };
const image = await editorImage();

// the four words of the 16x16 cell (x, y) of the BG1 tilemap (64x64 entries in four 32x32 screens) after a load
function shownWords(r: OwRender, x: number, y: number): number[] {
  const base = (r.ppuRegs[0x07] & 0xfc) << 9;
  const at = (tx: number, ty: number) => {
    const k = ((ty >> 5) * 2 + (tx >> 5)) * 0x400 + (ty & 31) * 32 + (tx & 31), a = base + k * 2;
    return r.vram[a] | (r.vram[a + 1] << 8);
  };
  return [at(x * 2, y * 2), at(x * 2, y * 2 + 1), at(x * 2 + 1, y * 2), at(x * 2 + 1, y * 2 + 1)];
}

const rom = new Rom(image.slice()), s = new RomEditSession(rom), emu = new OverworldEmulator(rom);
const r0 = emu.load(0, 0);
check(r0.ok, 'the overworld loads');
// the game's pointers of tiles 00–C0 are where the editor reads and writes them
check(Array.from({ length: OW_L1_TILES }, (_, t) => (0x050000 | map16Pointer(r0.wram, t)) === owTileAddr(t)).every(Boolean), 'the game\'s Map16 pointers of tiles 00–C0 are $05D000 + 8 per tile');
// a tile on the main map (x, y), as the game draws it before the change
// (one the submaps have too)
const l1 = gameL1(r0), r3 = emu.load(3, 0), l13 = Uint8Array.from(gameL1(r3));
const onSubmaps = new Set(Array.from({ length: 0x400 }, (_, k) => l13[0x400 + k]));
let at = { x: -1, y: -1 }, t = -1;
for (let y = 0; y < 32 && t < 0; y++) for (let x = 0; x < 32; x++) {
  const v = l1[l1Index(0, x, y)];
  if (v > 0 && v < OW_L1_TILES && onSubmaps.has(v) && !owTileWords(rom, v).every((w) => w === owTileWords(rom, v)[0])) { at = { x, y }; t = v; break; }
}
check(t > 0, `a layer 1 tile on the main map: ${t.toString(16)} at ${at.x},${at.y}`);
const old = owTileWords(rom, t);
check(same(shownWords(r0, at.x, at.y), old), 'the game draws the tile with its quarters');
// changed: mirrored (each quarter flipped, left and right swapped), palette 7 on its top left
const ws = [old[2] ^ FLIP_X, old[3] ^ FLIP_X, old[0] ^ FLIP_X, old[1] ^ FLIP_X];
ws[0] = (ws[0] & ~0x1c00) | (7 << 10);
const before = rom.data.slice();
s.edit(`OW tile ${t.toString(16)}: changed`, () => setOwTileWords(rom, t, ws));
check(s.history.undoStack.length === 1, 'one undo step');
const o = snesToPc(owTileAddr(t));
check(diff(before, rom.data).every((i) => i >= o && i < o + 8), 'only the tile\'s 8 bytes changed');
check(same(owTileWords(rom, t), ws), 'read back as written');
const r1 = emu.load(0, 0);
check(same(shownWords(r1, at.x, at.y), ws), 'the game draws the changed tile');
const r4 = emu.load(3, 0);
const places = Array.from({ length: 0x400 }, (_, k) => k).filter((k) => l13[0x400 + k] === t).map((k) => ({ x: ((k >> 8) & 1) * 16 + (k & 15), y: ((k >> 9) & 1) * 16 + ((k >> 4) & 15) }));
check(places.length > 0 && places.every((p) => same(shownWords(r4, p.x, p.y), ws)), `the submaps draw it changed too (${places.length} places)`);
s.undo();
check(same(rom.data, before), 'undone');
check(same(shownWords(emu.load(0, 0), at.x, at.y), old), 'the game draws it as before after the undo');
let threw = false;
try { setOwTileWords(rom, OW_L1_TILES, ws); } catch { threw = true; }
check(threw, 'no tile past C0');
const ranges = overworldDataRanges(rom);
check(ranges.some(([a, b]) => a <= snesToPc(owTileAddr(0)) && b >= snesToPc(owTileAddr(OW_L1_TILES - 1)) + 8), 'the tiles\' Map16 is overworld data');

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
