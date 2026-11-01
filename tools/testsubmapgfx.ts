// Graphics per submap (issue #83, core/submapgfx.ts), in Lunar Magic's layout.
// Palettes: the routine at $00AD32 is Lunar Magic's byte for byte (its table's address apart); the patched game shows
// every submap in the clean game's colors, before and after the special world (emulated); a color changed for one
// submap is shown there – when the overworld loads there and when Mario walks there from the main map – and on no
// other submap; one changed after the special world only after it.
// Graphics files: a file put into a submap's slot is in VRAM where the slot is when the overworld loads there and when
// Mario walks there from the main map; other submaps keep theirs; the default back: the game's file again.
// Layer 3: the patched game shows the clean game's layer 3 on every submap; LG1 of a submap is in VRAM there (also when
// Mario walks there); an LT3 file replaces the border there (the level name still written over it), not elsewhere.
// node tools/testsubmapgfx.ts
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { OverworldEmulator, l1Index, overworldDataRanges } from '../src/core/overworld.ts';
import { RAM, PAD } from '../src/core/ram.ts';
import {
  submapSlots, assignSubmapSlot,
  submapPalettePatch, submapColor, setSubmapColor, submapPaletteRanges, SUBMAPS, SUBMAP_PALETTES, SUBMAP_PALETTE_SIZE,
} from '../src/core/submapgfx.ts';
import { importGfxFile } from '../src/core/gfxfiles.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

// Lunar Magic's routine as in a ROM it saved (celery, LM 3.40, at $C0A197), its table's address (bytes 18–19, 30) left out
const LM_ROUTINE = 'aaad3119290f003a189b1003690700eb0a69....aaa00307a9ff018b5400..abe2306b';

// the colors (CGRAM) the overworld shows on each submap after it loaded, as after loading a save; special: the special
// world passed ($1EEB bit 7, set as the overworld loads)
function shown(rom: Rom, special: boolean): Uint8Array[] {
  const emu = new OverworldEmulator(rom), w = emu.snes.wram, cpu = emu.snes.cpu, exec = cpu.exec.bind(cpu);
  if (special) cpu.exec = (op: number) => { if (w[RAM.gameMode] === 0x0b || w[RAM.gameMode] === 0x0c) w[RAM.levelFlags + 0x49] |= 0x80; exec(op); };
  try { return Array.from({ length: SUBMAPS }, (_, m) => emu.load(m, 0).cgram); } finally { cpu.exec = exec; }
}
// the colors that differ between two CGRAMs
const diff = (a: Uint8Array, b: Uint8Array) => Array.from({ length: 256 }, (_, i) => i).filter((i) => a[i * 2] !== b[i * 2] || a[i * 2 + 1] !== b[i * 2 + 1]);
const color = (c: Uint8Array, i: number) => c[i * 2] | (c[i * 2 + 1] << 8);

const clean = new Rom(cleanImage()), rom = new Rom(await editorImage());
const p = submapPalettePatch(rom);
check(!!p, 'the submap palettes patch is installed');
{
  const code = [...rom.bytes(p!.routine, LM_ROUTINE.length / 2)].map((b) => hx(b).toLowerCase()).join('');
  check([...LM_ROUTINE].every((c, k) => c === '.' || c === code[k]), `the routine is Lunar Magic's byte for byte (${code})`);
  const [a, b] = submapPaletteRanges(rom)[0];
  check(b - a === SUBMAP_PALETTES * SUBMAP_PALETTE_SIZE && overworldDataRanges(rom).some(([x, y]) => x <= a && y >= b), 'the 14 palettes are overworld data');
  check(snesToPc(p!.table) >> 15 === (snesToPc(p!.table) + SUBMAP_PALETTES * SUBMAP_PALETTE_SIZE - 1) >> 15, 'the table lies in one bank (MVN)');
}

// ---- the game's colors ----
for (const special of [false, true]) {
  const a = shown(clean, special), b = shown(rom, special);
  const off = a.map((c, m) => diff(c, b[m]));
  check(off.every((d) => !d.length), `${special ? 'after the special world' : 'before the special world'}: every submap in the clean game's colors${off.some((d) => d.length) ? ` (differ: ${off.map((d, m) => `${m}: ${d.map((i) => hx(i)).join(' ')}`).join('; ')})` : ''}`);
}
{
  const a = shown(rom, false), b = shown(rom, true);
  const d = a.map((c, m) => diff(c, b[m]).length);
  check(d.some((n) => n > 0), `the special world changes colors (${d.join(' ')} colors per submap)`);
}

// ---- a color changed on Yoshi's Island ----
const C = 0x45; // a color of the map (palette 4) that no animation rewrites
const before = shown(rom, false);
const old = submapColor(rom, 1, false, C), mine = old ^ 0x1f;
setSubmapColor(rom, 1, false, C, mine);
{
  const a = shown(rom, false);
  check(color(a[1], C) === mine, `Yoshi's Island loaded: color ${hx(C)} as set (${hx(color(a[1], C), 4)}, set ${hx(mine, 4)})`);
  check(a.every((c, m) => m === 1 || !diff(c, before[m]).length), 'the other submaps keep their colors');
  check(diff(a[1], before[1]).join() === String(C), 'Yoshi\'s Island changes in that color only');
  const s = shown(rom, true);
  check(color(s[1], C) !== mine, 'after the special world Yoshi\'s Island has its special palette\'s color');
}
// the console after Mario walked from the main map onto Yoshi's Island (main map 02,14, whose path leads there); main:
// the CGRAM and VRAM on the main map before
function walk(rom: Rom): { s: LevelEmulator['snes']; main: { cgram: Uint8Array; vram: Uint8Array } } {
  const emu = new LevelEmulator(rom), s = emu.snes, w = s.wram;
  const i = l1Index(0, 2, 0x13);
  emu.startGameAt(i);
  w[RAM.submap] = w[RAM.submap + 1] = 0;
  emu.reloadOverworld();
  w[RAM.owTranslevels + i] = 1; w[RAM.levelFlags + 1] = 0x0f;
  const main = { cgram: s.cgram.slice(), vram: s.vram.slice() };
  let walked = false;
  for (let f = 0; f < 900; f++) {
    s.joy1 = f < 4 ? PAD.down : 0;
    s.runFrame();
    if (w[RAM.owProcess] !== 3) walked = true;
    else if (walked && f > 30) break;
  }
  for (let f = 0; f < 30; f++) s.runFrame();
  return { s, main };
}
// walked from the main map onto Yoshi's Island: its colors are loaded
{
  const { s, main: m } = walk(rom), w = s.wram, main = color(m.cgram, C);
  check(w[RAM.submap] === 1 && main !== mine && color(s.cgram, C) === mine, `walked onto Yoshi's Island: its color ${hx(C)} shown (${hx(color(s.cgram, C), 4)}; on the main map ${hx(main, 4)})`);
}
// after the special world, set for it
setSubmapColor(rom, 1, false, C, old);
setSubmapColor(rom, 1, true, C, mine);
{
  const a = shown(rom, false), s = shown(rom, true);
  check(color(a[1], C) === old && color(s[1], C) === mine, 'a color set after the special world: shown only after it');
}

// ---- graphics files ----
// the 0x1000-byte blocks of VRAM (a slot's 128 4bpp tiles) that differ
const blocks = (a: Uint8Array, b: Uint8Array) => Array.from({ length: a.length >> 12 }, (_, k) => k).filter((k) => a.subarray(k << 12, (k + 1) << 12).some((v, i) => v !== b[(k << 12) + i]));
const block = (v: Uint8Array, k: number) => v.subarray(k << 12, (k + 1) << 12);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
// block a holds the graphics of block b – but for the tiles the overworld animates there (at most 16 tiles of 32 bytes:
// the animation writes them every frame, a frame of its own in each) – and no longer those of `was`
const holds = (a: Uint8Array, b: Uint8Array, was: Uint8Array) => a.filter((v, i) => v !== b[i]).length <= 0x200 && a.filter((v, i) => v !== was[i]).length > 0x800;
const vrams = (rom: Rom) => { const emu = new OverworldEmulator(rom); return Array.from({ length: SUBMAPS }, (_, m) => emu.load(m, 0).vram); };
{
  const slots = submapSlots(rom, 1), fg1 = slots.find((x) => x.name === 'FG1')!, fg2 = slots.find((x) => x.name === 'FG2')!, sp1 = slots.find((x) => x.name === 'SP1')!;
  check(slots.map((x) => x.name).join() === 'FG1,FG2,FG3,FG4,SP1,SP2,SP3,SP4,LG1,LG2,LG3,LG4,LT3' && slots.every((x) => !x.custom), `Yoshi's Island's slots, all the game's (${slots.map((x) => `${x.name} ${hx(x.file)}`).join(', ')})`);
  const before = vrams(rom);
  assignSubmapSlot(rom, 1, 'FG1', fg2.file);
  check(submapSlots(rom, 1)[0].file === fg2.file && submapSlots(rom, 1)[0].custom, `FG1 of Yoshi's Island set to ${hx(fg2.file)}`);
  const after = vrams(rom), ch = blocks(before[1], after[1]);
  check(ch.length === 1 && holds(block(after[1], ch[0]), block(after[1], ch[0] + 1), block(before[1], ch[0])),
    `loaded on Yoshi's Island: one slot's graphics changed (blocks ${ch.map((k) => hx(k)).join(' ')}), now as FG2's`);
  check(after.every((v, m) => m === 1 || !blocks(before[m], v).length), 'the other submaps keep their graphics');
  // walked there from the main map: the slot loaded too, the rest as when the overworld loads there
  const { s, main } = walk(rom);
  check(s.wram[RAM.submap] === 1 && holds(block(s.vram, ch[0]), block(after[1], ch[0]), block(main.vram, ch[0])),
    'walked onto Yoshi\'s Island: its FG1 loaded');
  check(s.wram[RAM.gameMode] === 0x0e && s.ppuRegs[0] === 0x0f, `the overworld runs on after it, the screen on (game mode ${hx(s.wram[RAM.gameMode])}, INIDISP ${hx(s.ppuRegs[0])})`);
  // a sprite slot
  assignSubmapSlot(rom, 1, 'SP1', fg1.file);
  const sp = vrams(rom), chs = blocks(after[1], sp[1]);
  check(chs.length >= 1 && chs.every((k) => !ch.includes(k)), `SP1 set to ${hx(fg1.file)}: the sprite graphics changed (blocks ${chs.map((k) => hx(k)).join(' ')}, was ${hx(sp1.file)})`);
  assignSubmapSlot(rom, 1, 'FG1', 0xff);
  assignSubmapSlot(rom, 1, 'SP1', 0xff);
  const back = vrams(rom);
  check(!blocks(before[1], back[1]).length && submapSlots(rom, 1).every((x) => !x.custom), 'the defaults back: the game\'s graphics');
}

// ---- layer 3 ----
// layer 3's graphics (VRAM $4000–$47FF words: LG1–LG4, 0x800 bytes each) and tilemap ($5000–$5FFF)
const L3_GFX = 0x8000, L3_MAP = 0xa000, L3_END = 0xc000;
const l3 = (rom: Rom) => vrams(rom).map((v) => v.slice(L3_GFX, L3_END));
{
  const a = l3(clean), b = l3(rom);
  check(a.every((v, m) => same(v, b[m])), 'layer 3 (graphics and tilemap) on every submap as in the clean game');
  const lg = submapSlots(rom, 1).filter((x) => x.kind === 'lg'), lt3 = submapSlots(rom, 1).find((x) => x.kind === 'lt3')!;
  check(lg.map((x) => `${x.name} ${hx(x.file)}`).join() === 'LG1 28,LG2 29,LG3 2A,LG4 2B' && lt3.file === 0xff, `Yoshi's Island's layer 3 slots: ${lg.map((x) => `${x.name} ${hx(x.file)}`).join(', ')}, LT3 none`);
  assignSubmapSlot(rom, 1, 'LG1', 0x29);
  const c = l3(rom), g = (v: Uint8Array, k: number) => v.subarray(k * 0x800, (k + 1) * 0x800);
  check(same(g(c[1], 0), g(c[1], 1)) && !same(g(b[1], 0), g(c[1], 0)), 'LG1 of Yoshi\'s Island set to 29: loaded there');
  check(c.every((v, m) => m === 1 || same(v, b[m])), 'the other submaps keep the game\'s layer 3');
  const { s, main } = walk(rom);
  check(same(g(s.vram.subarray(L3_GFX), 0), g(c[1], 0)) && !same(g(main.vram.subarray(L3_GFX), 0), g(c[1], 0)), 'walked onto Yoshi\'s Island: its LG1 loaded');
  // an LT3 file: tile 0x55 everywhere (the start of layer 3, 256x256)
  const map = new Uint8Array(0x2000);
  for (let i = 0; i < map.length; i += 2) { map[i] = 0x55; map[i + 1] = 0x39; }
  importGfxFile(rom, 0xe80, map);
  assignSubmapSlot(rom, 1, 'LT3', 0xe80, { dest: 1, size: 2 });
  const d = l3(rom), m1 = d[1].subarray(L3_MAP - L3_GFX), w = (v: Uint8Array, i: number) => v[i * 2] | (v[i * 2 + 1] << 8);
  const rows = Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) => w(m1, y * 32 + x)));
  const own = rows.flat().filter((t) => t === 0x3955).length, name = rows[4].slice(11, 30).filter((t) => t !== 0x3955).length;
  check(own >= 32 * 32 - 32 && name > 0, `LT3 set on Yoshi's Island: its tilemap there (${own} of 1024 tiles; the game writes the level name over row 4 – ${name} tiles – and the lives)`);
  check(d.every((v, m) => m === 1 || same(v, b[m])), 'the other submaps keep the game\'s border');
  for (const n of ['LG1', 'LT3']) assignSubmapSlot(rom, 1, n, 0xff);
  check(l3(rom).every((v, m) => same(v, b[m])), 'the defaults back: the game\'s layer 3');
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
