// The overworld drawn from the BG1/BG2 character base the game sets (BG12NBA, $210B; issue #373). The clean game with
// the base its init writes patched to $77 and its layer graphics uploaded to $E000 (where 8x8 tile 000 then is,
// 100–1FF wrapping around to $0000) draws the same maps, picks the same 8x8 tiles and finds the same tiles with a look
// of their own as the clean game – drawn from 0 it would not. Journey to Kaizo (resources_local, skipped without it)
// sets $77 itself: its layer 1's 8x8s 200–2FF, past the FG slots, are drawn from $2000–$3FFF, where the game has them.
// node tools/testowcharbase.ts
import { existsSync, readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { OverworldEmulator, MAP_NAMES, drawOwMap, gameL1, gameL2, owTileAt, owCharBase, owTileWords, owTileCaches, OW_L1_TILES, type OwRender, type OwTileCaches } from '../src/core/overworld.ts';
import { hasOwnLook } from '../src/core/owlook.ts';
import { TileCache } from '../src/core/render.ts';
import { cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// the clean game moved: BG12NBA $77 and every upload of layer graphics 0x7000 words further (wrapping at 0x8000)
const clean = new Rom(cleanImage()), moved = new Rom(cleanImage());
const shift = (a: number) => (a + 0x7000) & 0x7fff, w16 = (a: number, v: number) => moved.writeAt(snesToPc(a), Uint8Array.of(v & 0xff, v >> 8));
moved.data[snesToPc(0x008a8f)] = 0x77; // the screen set-up's LDA #$00 : STA $210B
for (let k = 0; k < 4; k++) moved.data[snesToPc(0x00a9d6 + k)] = shift(moved.data[snesToPc(0x00a9d6 + k)] << 8) >> 8; // the files' VRAM (high bytes)
for (let k = 0; k < 24; k++) { const a = 0x05b93b + k * 2, v = moved.r16(a); if (v) w16(a, shift(v)); } // the animations' VRAM per frame (0: none)
w16(0x00a3db, shift(0x0800)); w16(0x00a400, shift(0x0900)); // the NMI's animation upload to $0800 split in two halves
w16(0x00a4eb, shift(0x0750)); // the overworld's upload of tiles 075–07F
// a map's image as the editor draws it: layer 2 as in VRAM, layer 1 as the game has it
const image = (rom: Rom, r: OwRender, map: number, tcs?: OwTileCaches) => {
  const region = map > 0 ? 1 : 0, l2 = new Uint16Array(0x2000);
  l2.set(gameL2(r), region * 0x1000);
  return drawOwMap(rom, r, region, null, l2, tcs);
};
// both layers' 8x8s read from VRAM 0, as the editor drew them before
const from0 = (r: OwRender): OwTileCaches => ({ l1: new TileCache(r.vram, r.cgram, 0), l2: new TileCache(r.vram, r.cgram, 0) });
const differing = (a: Uint32Array, b: Uint32Array) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);

const ce = new OverworldEmulator(clean), me = new OverworldEmulator(moved);
for (const map of [0, 1, 4]) {
  const c = ce.load(map, 0), m = me.load(map, 0), name = MAP_NAMES[map];
  check(c.ok && m.ok && owCharBase(c, 1) === 0 && owCharBase(m, 1) === 0xe000 && owCharBase(m, 2) === 0xe000, `${name}: loaded, the moved ROM's base $E000 for both layers`);
  const want = image(clean, c, map), got = image(moved, m, map), drawn0 = image(moved, m, map, from0(m));
  check(!differing(want, got), `${name}: the moved ROM's map drawn as the clean game's (${differing(want, got)} pixels differ)`);
  // (an eighth of the map at least: most of it is drawn from other graphics)
  check(differing(want, drawn0) > 0x8000, `${name}: drawn from VRAM 0 it differs (${differing(want, drawn0)} pixels)`);
  let picks = 0;
  for (let y = 0; y < 512; y += 3) for (let x = 0; x < 512; x += 3) {
    const a = owTileAt(c, x, y), b = owTileAt(m, x, y);
    if (a?.word !== b?.word || a?.layer !== b?.layer) picks++;
  }
  check(!picks, `${name}: the 8x8 tile picked under the mouse as in the clean game (${picks} differ)`);
  // (of the tiles drawn from the layer graphics: 8x8s past 1FF read other VRAM, which the move leaves in place – the
  // game's unused tile 15F has one)
  const inGfx = Array.from({ length: OW_L1_TILES }, (_, t) => t).filter((t) => owTileWords(clean, t).every((w) => (w & 0x3ff) < 0x200));
  const looks = inGfx.filter((t) => hasOwnLook(c, owTileWords(clean, t)) !== hasOwnLook(m, owTileWords(moved, t)));
  const at0 = inGfx.filter((t) => hasOwnLook(c, owTileWords(clean, t)) !== hasOwnLook({ vram: m.vram, ppuRegs: new Uint8Array(0x40) }, owTileWords(moved, t)));
  check(inGfx.length > 200 && !looks.length && at0.length > 0, `${name}: the same of ${inGfx.length} layer 1 tiles have a look of their own (${looks.length} differ; from VRAM 0 ${at0.length})`);
}

// ---- Journey to Kaizo ----
const JTK = 'resources_local/Journey to Kaizo v1.1 (LM rom).smc';
if (!existsSync(JTK)) console.log(`skip (no ${JTK}): a ROM setting the base itself`);
else {
  const raw = readFileSync(JTK), rom = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
  const r = new OverworldEmulator(rom).load(0, 0);
  check(r.ok && r.ppuRegs[0x0b] === 0x77 && owCharBase(r, 1) === 0xe000, 'Journey to Kaizo: BG12NBA $77, layer 1 from $E000');
  const past = new Set<number>();
  for (const t of gameL1(r)) for (const w of owTileWords(rom, t)) if ((w & 0x3ff) >= 0x200) past.add(w & 0x3ff);
  // (8x8 n from $E000 + n * 32, wrapping: 200–2FF are at $2000–$3FFF, which a cache from 0 has as 100–1FF)
  const tc0 = new TileCache(r.vram, r.cgram, 0);
  const l1 = owTileCaches(r).l1, same = (a: Uint32Array, b: Uint32Array) => a.every((v, i) => v === b[i]);
  const wrapped = [...past].filter((n) => tc0.get(n - 0x100).some((v) => v) && same(l1.get(n), tc0.get(n - 0x100))).length;
  check(past.size > 0 && wrapped === past.size, `Journey to Kaizo: its layer 1's ${past.size} 8x8s 200–2FF drawn from $2000–$3FFF, each with pixels (${wrapped})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
