// A submap's map in the graphics workspace (issue #262): a click picks the 8x8 tile shown under the mouse – layer 1's
// where its pixel is not transparent (the quarter of the layer 1 tile's Map16 there), else layer 2's – and the slot it
// is in names the graphics file holding it (the file's pixels are VRAM's there). The map loaded after the special
// world shows the submap's colors after it.
// node tools/testowtilepick.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, gameL1, gameL2, l1Index, l2Index, owTileWords, owTileAt, OW_L1_TILES } from '../src/core/overworld.ts';
import { submapSlots, submapPalette, SUBMAPS } from '../src/core/submapgfx.ts';
import { slotOfTile } from '../src/core/gfxslots.ts';
import { readGfx } from '../src/core/gfxfiles.ts';
import { decodeTile } from '../src/core/gfx.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

const rom = new Rom(await editorImage()), emu = new OverworldEmulator(rom);
const M = 1, region = 1; // Yoshi's Island
const r = emu.load(M, 0);
check(r.ok, 'Yoshi\'s Island loads');

// the color index of pixel (x, y) of the 8x8 tile `w` in VRAM (flips applied)
const pixel = (w: number, x: number, y: number) => {
  const out = new Uint8Array(64);
  decodeTile(r.vram, (w & 0x3ff) * 32, 4, out);
  return out[((w & 0x8000) ? 7 - y : y) * 8 + ((w & 0x4000) ? 7 - x : x)];
};
// the Map16 quarter of the layer 1 tile at pixel (x, y) of the region's map (TL, BL, TR, BR)
const l1 = gameL1(r), l2 = gameL2(r);
const quarterAt = (x: number, y: number) => owTileWords(rom, l1[l1Index(region, x >> 4, y >> 4)])[((x >> 3) & 1) * 2 + ((y >> 3) & 1)];
const l2At = (x: number, y: number) => l2[l2Index(region, x >> 3, y >> 3) - region * 0x1000];

// every pixel of the map: layer 1's quarter where its pixel shows, else layer 2's tile
let opaque: { x: number; y: number } | null = null, clear: { x: number; y: number } | null = null, wrong = 0;
for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
  const t = l1[l1Index(region, x >> 4, y >> 4)];
  if (t >= OW_L1_TILES) continue;
  const q = quarterAt(x, y), shows = pixel(q, x & 7, y & 7) !== 0;
  const got = owTileAt(r, x, y), want = shows ? { word: q, layer: 1 } : pixel(l2At(x, y), x & 7, y & 7) ? { word: l2At(x, y), layer: 2 } : null;
  if (JSON.stringify(got) !== JSON.stringify(want)) { if (!wrong++) console.log(`  at ${x},${y}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); }
  if (shows && t) opaque ??= { x, y };
  if (!shows && want) clear ??= { x, y };
}
check(!wrong, `every pixel: the 8x8 tile shown there (${wrong} wrong)`);
check(!!opaque && owTileAt(r, opaque.x, opaque.y)?.layer === 1, `a layer 1 tile's pixel picks its quarter (${opaque && `${opaque.x},${opaque.y}`})`);
check(!!clear && owTileAt(r, clear.x, clear.y)?.layer === 2, `a transparent pixel of layer 1 picks layer 2's tile (${clear && `${clear.x},${clear.y}`})`);
check(owTileAt(r, -1, 0) === null && owTileAt(r, 512, 0) === null, 'outside the map: none');

// the slot of every tile picked on the map names the file whose pixels are in VRAM there (a 3bpp file's colors in the
// low bits: the game uploads FG3/FG4 with bit 3 set); the tiles the game animates (written over after the load) apart
{
  const slots = submapSlots(rom, M), nums = new Set<number>();
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) { const p = owTileAt(r, x, y); if (p) nums.add(p.word & 0x3ff); }
  const off: string[] = [], none: number[] = [];
  for (const num of nums) {
    const s = slotOfTile(slots, num);
    if (!s) { none.push(num); continue; }
    const f = readGfx(rom, s.file), k = num - s.first, vram = new Uint8Array(64), mask = (1 << f.bpp) - 1;
    decodeTile(r.vram, num * 32, 4, vram);
    if (!vram.every((v, i) => f.pix[k * 64 + i] === (v & mask))) off.push(`${hx(num, 3)} (${s.name})`);
  }
  check(!none.length, `every tile picked is in one of the submap's slots${none.length ? ` (not: ${none.map((n) => hx(n, 3)).join(' ')})` : ''}`);
  check(nums.size > 100 && off.length <= 8, `${nums.size - off.length} of ${nums.size} tiles picked: their slot's file is in VRAM there (animated: ${off.join(' ')})`);
}

// ---- after the special world ----
{
  const special = Array.from({ length: SUBMAPS }, (_, m) => emu.load(m, 0, true));
  const normal = Array.from({ length: SUBMAPS }, (_, m) => emu.load(m, 0));
  const col = (c: Uint8Array, i: number) => c[i * 2] | (c[i * 2 + 1] << 8);
  let changed = 0;
  for (let m = 0; m < SUBMAPS; m++) {
    const sp = submapPalette(rom, m, true), np = submapPalette(rom, m, false), n = normal[m].cgram, c = special[m].cgram;
    // (the colors no animation rewrites: those the load before the special world shows as in its palette)
    const kept = Array.from({ length: 256 }, (_, i) => i).filter((i) => col(n, i) === col(np, i));
    const off = kept.filter((i) => col(c, i) !== col(sp, i));
    check(special[m].ok && !off.length, `submap ${m} after the special world: its colors after it (${off.length ? `differ: ${off.map((i) => hx(i)).join(' ')}` : `${kept.length} compared`})`);
    if (kept.some((i) => col(c, i) !== col(n, i))) changed++;
  }
  check(changed > 0, `the special world changes the colors shown (${changed} submaps)`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
