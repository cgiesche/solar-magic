// Level names as free text in Lunar Magic's layout (issue #82, core/levelnames.ts, docs/research/lunar-magic-level-names.md):
// the patched clean game writes the same name for every translevel as the clean game (the overworld's code run for
// each, emulated); its routine is Lunar Magic's byte for byte (from ROMs Lunar Magic saved), the table 0x60 × 19 bytes
// in a RATS block; a changed name is one ROM edit and the game shows it on the overworld's border (emulated load);
// the text follows Lunar Magic's table with its MultiChar tiles and `\XX`.
// node tools/testlevelnames.ts
import { Rom, snesToPc } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { OverworldEmulator, overworldDataRanges } from '../src/core/overworld.ts';
import {
  levelNamePatch, levelNameTiles, setLevelNameTiles, levelName, shownNameStripe, decodeName, encodeName,
  NAME_LEN, NAME_TRANSLEVELS, NAME_SPACE, NAME_VRAM,
} from '../src/core/levelnames.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const clean = new Rom(cleanImage()), image = await editorImage();
const rom = new Rom(image.slice());

// ---- the layout ----
{
  const p = levelNamePatch(rom);
  check(!!p, 'installed: a JSL to $03BB20 at $048E81 (the overworld loads) and $049549 (Mario stops on a tile)');
  check([0x048e85, 0x04954d].every((a) => [...rom.bytes(a, 6)].every((b) => b === 0xea)) && rom.r16(0x048e8b) === 0x04a6 && rom.r8(0x049553) === 0xee,
    'then NOPs up to the game\'s next instruction, as Lunar Magic\'s');
  // Lunar Magic's routine at $03BB20 as in three ROMs it saved, the table's address (its operand at $03BB57) aside
  const lm = '85020a0a0a0a8500a5020a18650265 00aa8bf47f7fababad7b83a8186926008502186904008d7b83a9002599 7f83a9508b997d83e220bf' +
    '______998183a939998283c8c8e8c40290eda9ff998183c220ab6b';
  const want = lm.replace(/ /g, '').match(/../g)!, got = [...rom.bytes(0x03bb20, want.length)].map((b) => b.toString(16).padStart(2, '0'));
  check(want.every((b, k) => b === '__' || b === got[k]), 'the routine $03BB20–$03BB71: Lunar Magic\'s byte for byte');
  const rats = rom.scanRats().find((r) => r.start + 8 === snesToPc(p!.table));
  check(!!rats && rats.size >= NAME_TRANSLEVELS * NAME_LEN, `the table: ${hx(NAME_TRANSLEVELS)} × ${NAME_LEN} bytes in a RATS block (${rats?.size.toString(16)})`);
  const pc = snesToPc(p!.table);
  check(overworldDataRanges(rom).some(([a, b]) => a <= pc && b >= pc + NAME_TRANSLEVELS * NAME_LEN), 'the names are overworld data');
}

// ---- the clean game's names unchanged (over all translevels) ----
{
  const noName = new Set<number>();
  const differ: number[] = [];
  for (let tl = 0; tl < NAME_TRANSLEVELS; tl++) {
    if (clean.r16(0x04a0fc + tl * 2) === 0xffff) { noName.add(tl); continue; }
    if (shownNameStripe(clean, tl).join() !== shownNameStripe(rom, tl).join()) differ.push(tl);
  }
  check(!differ.length, `the game writes the same name for all ${NAME_TRANSLEVELS - noName.size} named translevels as the clean game${differ.length ? ` (differ: ${differ.map(hx).join(' ')})` : ''}`);
  check([...noName].every((tl) => levelNameTiles(rom, tl).every((t) => t === NAME_SPACE)), `those the clean game shows RAM as letters for (${[...noName].map(hx).join(' ')}): blank`);
  const st = shownNameStripe(rom, 0x14);
  check(st.length === 4 + NAME_LEN * 2 + 1 && st[0] === NAME_VRAM >> 8 && st[1] === (NAME_VRAM & 0xff) && st.at(-1) === 0xff, 'the stripe: layer 3 at $508B, 19 tiles, the end mark');
  check(levelName(rom, 0x14) === 'YELLOW SWITCH PALACE' && levelName(rom, 0x42) === 'FOREST OF ILLUSION 1' && levelName(rom, 0) === '(no name)', 'names as text: MultiChar tiles as their letters, a blank one "(no name)"');
}

// ---- text ----
{
  const all = Array.from({ length: NAME_TRANSLEVELS }, (_, tl) => levelNameTiles(rom, tl));
  const back = (multi: boolean) => all.every((t) => {
    const e = encodeName(decodeName(t, multi), multi);
    return !e.missing.length && [...e.tiles, ...Array(NAME_LEN - e.tiles.length).fill(NAME_SPACE)].join() === t.join();
  });
  check(back(true) && back(false), 'every name read back from its text, with and without MultiChar tiles');
  check(decodeName(all[0x14], false).startsWith('\\38\\39\\3A\\3B\\3C '), 'without MultiChar tiles: \\XX');
  check(encodeName('YELLOW').tiles.length === 5 && encodeName('YELLOW', false).tiles.length === 6, '"YELLOW": 5 squished tiles, 6 without MultiChar');
  const e = encodeName('A~B\\5Ag');
  check(e.tiles.join() === [0x00, 0x01, 0x5a, 0x46].join() && e.missing.length === 1 && e.missing[0].ch === '~' && e.missing[0].at === 1 && e.shown.join() === [0, -1, 1, 0x5a, 0x46].join(),
    'a character the font lacks: left out, marked; \\5A a tile by number');
  let threw = false;
  try { setLevelNameTiles(new Rom(image.slice()), 1, encodeName('THIS NAME IS FAR TOO LONG').tiles); } catch { threw = true; }
  check(threw, 'a name of more than 19 tiles refused');
}

// ---- a changed name: one ROM edit, the game shows it ----
{
  const r = new Rom(image.slice()), s = new RomEditSession(r), emu = new OverworldEmulator(r);
  // the name on the border after the overworld loads: of the level tile Mario stands on
  const border = () => {
    const o = emu.load(1, 0);
    return Array.from({ length: NAME_LEN }, (_, k) => o.vram[NAME_VRAM * 2 + k * 2]);
  };
  const shown = border(), tl = Array.from({ length: NAME_TRANSLEVELS }, (_, t) => t).find((t) => t && levelNameTiles(r, t).join() === shown.join()) ?? -1;
  check(tl > 0, `the border shows the name of Mario's level after loading (translevel ${hx(tl)} "${tl > 0 ? levelName(r, tl) : ''}")`);
  const before = r.data.slice(), name = encodeName('YELLOW HOUSE \\5A7').tiles;
  s.edit(`Level name`, () => setLevelNameTiles(r, tl, name));
  const changed = [...r.data.keys()].filter((i) => r.data[i] !== before[i]);
  const at = snesToPc(levelNamePatch(r)!.table) + tl * NAME_LEN;
  check(s.history.undoStack.length === 1 && changed.every((i) => i >= at && i < at + NAME_LEN), 'a changed name: one ROM edit of its 19 bytes');
  const now = border();
  check(now.join() === [...name, ...Array(NAME_LEN - name.length).fill(NAME_SPACE)].join(), `the game shows the new name on the border (${now.map(hx).join(' ')})`);
  s.undo();
  check(border().join() === shown.join(), 'undone: the old name again');
}

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
