// The graphics slots of a level (gfxslots.ts): all slots with their files and defaults, read from the ROM;
// assigning a file or the default to one slot, with the slot's own rules (an LT3 file copies at most its
// own length).
import { Rom } from '../src/core/rom.ts';
import { loadLevel } from '../src/core/level.ts';
import { setGfxEntry } from '../src/core/patches.ts';
import { levelLayer3, LT3_SIZES } from '../src/core/layer3gfx.ts';
import { levelSlots, layerSlots, slotOfTile, assignSlot } from '../src/core/gfxslots.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const LV = 0x106;
const slotsOf = (rom: Rom) => levelSlots(rom, LV, loadLevel(rom, LV).header);
const slot = (rom: Rom, name: string) => slotsOf(rom).find((s) => s.name === name)!;
const list = (rom: Rom) => slotsOf(rom).map((s) => `${s.name}=${s.file.toString(16)}${s.custom ? '*' : ''}`).join(' ');

// a clean-game level: the game's files of its tileset (0, Normal 1) and sprite set, layer 3's 28-2B, no BG2/BG3/LT3
{
  const rom = fresh();
  check(list(rom) === 'FG1=14 FG2=17 BG1=19 FG3=15 SP1=0 SP2=1 SP3=13 SP4=9 BG2=ff BG3=ff LG1=28 LG2=29 LG3=2a LG4=2b LT3=ff', `clean-game level 106: ${list(rom)}`);
  check(slotsOf(rom).every((s) => s.file === s.def || s.def === 0xff), 'its files are the defaults');
  check(layerSlots(slotsOf(rom)).map((s) => `${s.name}@${s.first.toString(16)}`).join(' ') === 'FG1@0 FG2@80 BG1@100 FG3@180', 'layer slots in VRAM order (no BG2/BG3 while empty)');
  check(slotOfTile(slotsOf(rom), 0x123)?.name === 'BG1' && !slotOfTile(slotsOf(rom), 0x200), 'the layer slot of an 8x8 tile');
}

// a file into each kind of slot, FF the default again
{
  const rom = fresh();
  for (const n of [0x80, 0x81]) setGfxEntry(rom, n, rom.allocWrite(new Uint8Array(0x1000)), true, 0x1000);
  setGfxEntry(rom, 0xe00, rom.allocWrite(new Uint8Array(0x800)), true, 0x800);
  assignSlot(rom, LV, 'FG2', 0x80);
  assignSlot(rom, LV, 'SP4', 0x81);
  assignSlot(rom, LV, 'BG3', 0x80);
  assignSlot(rom, LV, 'LG2', 0xe00);
  check(list(rom) === 'FG1=14 FG2=80* BG1=19 FG3=15 SP1=0 SP2=1 SP3=13 SP4=81* BG2=ff BG3=80* LG1=28 LG2=e00* LG3=2a LG4=2b LT3=ff', `assigned: ${list(rom)}`);
  check(layerSlots(slotsOf(rom)).map((s) => s.name).join(' ') === 'FG1 FG2 BG1 FG3 BG3', 'BG3 is a layer slot once it holds a file');
  for (const n of ['FG2', 'SP4', 'BG3', 'LG2']) assignSlot(rom, LV, n, 0xff);
  check(list(rom) === 'FG1=14 FG2=17 BG1=19 FG3=15 SP1=0 SP2=1 SP3=13 SP4=9 BG2=ff BG3=ff LG1=28 LG2=29 LG3=2a LG4=2b LT3=ff', `FF restores the defaults: ${list(rom)}`);
  let threw = false;
  try { assignSlot(rom, LV, 'XY1', 0x80); } catch { threw = true; }
  check(threw, 'no slot of that name: an error');
}

// LT3: a file copies at most its own length; FF none again
{
  const rom = fresh();
  setGfxEntry(rom, 0xe01, rom.allocWrite(new Uint8Array(0x800)), true, 0x800);
  setGfxEntry(rom, 0xe02, rom.allocWrite(new Uint8Array(0x2000)), true, 0x2000);
  check(LT3_SIZES[levelLayer3(rom, LV).size] === 0x2000, 'LT3 copy size 0x2000 by default');
  assignSlot(rom, LV, 'LT3', 0xe01);
  check(slot(rom, 'LT3').file === 0xe01 && LT3_SIZES[levelLayer3(rom, LV).size] === 0x800, 'a 0x800-byte tilemap: the copy fits it (0x800)');
  assignSlot(rom, LV, 'LT3', 0xe02);
  check(LT3_SIZES[levelLayer3(rom, LV).size] === 0x800, 'a longer one keeps the copy size chosen');
  assignSlot(rom, LV, 'LT3', 0xe01, { dest: 3, size: 2 });
  check(levelLayer3(rom, LV).dest === 3, 'with a place: where it goes');
  assignSlot(rom, LV, 'LT3', 0xff);
  check(slot(rom, 'LT3').file === 0xff && !slot(rom, 'LT3').custom, 'FF: no LT3');
}

if (bad) { console.error(`${bad} failed`); process.exit(1); }
console.log('all ok');
