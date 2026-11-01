// Graphics per submap (issue #83, core/submapgfx.ts), in Lunar Magic's layout.
// Palettes: the routine at $00AD32 is Lunar Magic's byte for byte (its table's address apart); the patched game shows
// every submap in the clean game's colors, before and after the special world (emulated); a color changed for one
// submap is shown there – when the overworld loads there and when Mario walks there from the main map – and on no
// other submap; one changed after the special world only after it.
// node tools/testsubmapgfx.ts
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { OverworldEmulator, l1Index, overworldDataRanges } from '../src/core/overworld.ts';
import { RAM, PAD } from '../src/core/ram.ts';
import {
  submapPalettePatch, submapColor, setSubmapColor, submapPaletteRanges, SUBMAPS, SUBMAP_PALETTES, SUBMAP_PALETTE_SIZE,
} from '../src/core/submapgfx.ts';
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
// walked from the main map onto Yoshi's Island (main map 02,14, whose path leads there): its colors are loaded
{
  const emu = new LevelEmulator(rom), s = emu.snes, w = s.wram;
  const i = l1Index(0, 2, 0x13);
  emu.startGameAt(i);
  w[RAM.submap] = w[RAM.submap + 1] = 0;
  emu.reloadOverworld();
  w[RAM.owTranslevels + i] = 1; w[RAM.levelFlags + 1] = 0x0f;
  const main = color(s.cgram, C);
  let walked = false;
  for (let f = 0; f < 900; f++) {
    s.joy1 = f < 4 ? PAD.down : 0;
    s.runFrame();
    if (w[RAM.owProcess] !== 3) walked = true;
    else if (walked && f > 30) break;
  }
  for (let f = 0; f < 30; f++) s.runFrame();
  check(w[RAM.submap] === 1 && main !== mine && color(s.cgram, C) === mine, `walked onto Yoshi's Island: its color ${hx(C)} shown (${hx(color(s.cgram, C), 4)}; on the main map ${hx(main, 4)})`);
}
// after the special world, set for it
setSubmapColor(rom, 1, false, C, old);
setSubmapColor(rom, 1, true, C, mine);
{
  const a = shown(rom, false), s = shown(rom, true);
  check(color(a[1], C) === old && color(s[1], C) === mine, 'a color set after the special world: shown only after it');
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
