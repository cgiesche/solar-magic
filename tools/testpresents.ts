// Nintendo Presents' fields (presents.ts): the logo's OBJ with the ROM bytes the game reads their positions, tiles
// and properties from, the time, the colours and the graphics file – found by emulation (the clean game's addresses,
// here only to check); a field written and shown by the game; a logo the game computes has no fields.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { reachScreens, gameScreens } from '../src/core/pregame.ts';
import { learnPresents, presentsLogo, writePresentsValue, sharedFields } from '../src/core/presents.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const hex = (n: number) => n.toString(16);

{
  const rom = fresh(), emu = new LevelEmulator(rom), screens = reachScreens(emu), pr = screens.find((s) => s.id === 'presents')!;
  const t0 = Date.now(), logo = learnPresents(emu, pr), ms = Date.now() - t0;
  check(logo.objs.length === 4 && logo.objs.every((o) => o.big), `the logo's four OBJ, 16x16 (${ms} ms)`);
  check(same(logo.objs.map((o) => o.x.value), [0x60, 0x70, 0x80, 0x90]) && same(logo.objs.map((o) => o.x.at), [0, 1, 2, 3].map((i) => snesToPc(0x009389) + i)), 'their X positions, read from $009389');
  check(same(logo.objs.map((o) => o.tile.value), [2, 4, 6, 8]) && same(logo.objs.map((o) => o.tile.at), [0, 1, 2, 3].map((i) => snesToPc(0x00938d) + i)), 'their tiles, read from $00938D');
  check(logo.objs.every((o) => o.y.value === 0x70 && o.y.at === snesToPc(0x0093a5)), 'their Y position, one byte at $0093A5');
  check(logo.objs.every((o) => o.props.value === 0x30 && o.props.at === snesToPc(0x0093b0)), 'their properties, one byte at $0093B0');
  check(sharedFields(logo.objs, (o) => o.y).length === 1 && sharedFields(logo.objs, (o) => o.x).length === 4 && same(sharedFields(logo.objs, (o) => o.y)[0].objs, [1, 2, 3, 4]), 'Y is one field of all four, X one of each');
  check(logo.time?.value === 0x40 && logo.time.at === snesToPc(0x0093c6), `the time: $40 frames, read from $0093C6 (${logo.time ? `${hex(logo.time.value)} at pc ${hex(logo.time.at)}` : 'none'})`);
  console.log(`  (colours: ${logo.colours.map((c) => `${hex(c.index)}=${hex(c.value)}@${c.at < 0 ? '-' : hex(c.at)}`).join(' ')})`);
  // (the ROM map's colours at $00B280 are palette 8's colours 2–7; the logo's pixels use colour 1 only – the white the
  // game's palette load gives colour 1 of every palette, an operand in its code)
  const c0 = logo.colours[0];
  check(logo.colours.length === 1 && c0.index === 0x81 && c0.value === 0x7fff && c0.at >= 0 && c0.shared >= 7 && (rom.data[c0.at] | (rom.data[c0.at + 1] << 8)) === 0x7fff,
    `the logo's one colour: CGRAM $81, the white ${c0?.shared} other entries are loaded from too`);
  check(logo.gfx?.file === 0 && logo.gfx.tile === 2, `its graphics file: GFX00, the first OBJ at its tile 2 (${logo.gfx ? `${hex(logo.gfx.file)}, tile ${hex(logo.gfx.tile)}` : 'none'})`);
  check(emu.snes.hook === null && !emu.snes.taintOn && same(rom.data, base), 'the emulator left without a hook or source tracking, the ROM as it was');

  // fields written: the game shows them
  writePresentsValue(rom, logo.objs[0].x, 0x20);
  writePresentsValue(rom, logo.time!, 0x18);
  writePresentsValue(rom, logo.colours[0], 0x7c1f, 2);
  const again = gameScreens(emu), pr2 = again.find((s) => s.id === 'presents')!, logo2 = presentsLogo(emu, pr2);
  check(logo2.objs[0].x.value === 0x20 && (pr2.state.oam as Uint8Array)[logo.objs[0].index * 4] === 0x20, 'X written: the first OBJ is there');
  check(logo2.time?.value === 0x18 && logo2.time.at === logo.time!.at && pr2.path!.pad.length <= pr.path!.pad.length, 'the time written: learned again as written');
  check(logo2.colours[0].value === 0x7c1f && logo2.colours[0].at === logo.colours[0].at, 'a colour written: the logo shows it');
  check(presentsLogo(emu, pr2) === logo2, 'kept: asked again, the same');
  let no = '';
  try { writePresentsValue(rom, { value: 1, at: -1 }, 2); } catch (e) { no = String(e); }
  check(!!no, 'a value the game computes is not written');
}

// a logo whose X positions the game computes (the table's read replaced: TXA : ASL ×4 → 0, $10, $20, $30): shown,
// no X fields; the other fields stay
{
  const rom = fresh(), d = rom.data, pat = [0xbd, 0x89, 0x93]; // LDA $9389,X
  let at = -1;
  for (let o = snesToPc(0x009390); o < snesToPc(0x0093c0) && at < 0; o++) if (pat.every((b, i) => d[o + i] === b)) at = o;
  rom.writeAt(at, Uint8Array.from([0x8a, 0x0a, 0x0a])); // TXA : ASL : ASL (0, 4, 8, 12)
  const emu = new LevelEmulator(rom), pr = reachScreens(emu).find((s) => s.id === 'presents');
  const logo = pr ? learnPresents(emu, pr) : null;
  check(at >= 0 && !!logo && logo.objs.length === 4 && same(logo.objs.map((o) => o.x.value), [0, 4, 8, 12]) && logo.objs.every((o) => o.x.at < 0 && o.tile.at >= 0),
    `positions the game computes: shown, no fields (${logo?.objs.map((o) => o.x.value).join(', ')})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
