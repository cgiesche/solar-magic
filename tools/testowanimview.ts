// The overworld's animations as the Animations tab shows a submap's (#260, owanimview.ts), by emulation: the event
// triggers 01–08 (Event Manual 8–F) read from the console after the load and switched for the preview (the second
// frame set shown, the map's events as they were), the colors the game itself keeps setting on a submap (Mario's, the
// level dots', the lightning where it is on), not those the submap's own animations set.
// node tools/testowanimview.ts
import { Rom } from '../src/core/rom.ts';
import { OverworldEmulator, OverworldLoads, gameL1 } from '../src/core/overworld.ts';
import { writeSubmapList, writeAltFile, emptyList, setSubmapAnimSettings, setRotationRange, NO_DOT_COLORS, type ExList } from '../src/core/exanim.ts';
import { setSubmapLightning } from '../src/core/owoptions.ts';
import { submapPalette } from '../src/core/submapgfx.ts';
import { eventTriggerState, owTriggerRender, owGameColors } from '../src/core/owanimview.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const names = (c: number[]) => c.map(hx).join(' ');

const rom = new Rom(await editorImage());
const loads = () => new OverworldLoads(new OverworldEmulator(rom), 16);

// ---- the game's colors ----
const GAME = [0x6d, 0x7d, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f];
{
  const c1 = owGameColors(loads(), 1, 0, false), c4 = owGameColors(loads(), 4, 0, false);
  check(names(c1) === names(GAME), `Yoshi's Island: Mario's colors and the level dots' 6D, 7D (${names(c1)})`);
  check(names(c4) === names([0x47, ...GAME]), `the Valley of Bowser: the lightning's 47 too (${names(c4)})`);
  check(names(owGameColors(loads(), 4, 0, true)) === names(c4), 'after the special world the same');
  setSubmapLightning(rom, 1, true);
  setSubmapAnimSettings(rom, 1, NO_DOT_COLORS);
  const c = owGameColors(loads(), 1, 0, false);
  check(c.includes(0x47) && !c.includes(0x6d) && !c.includes(0x7d), `Yoshi's Island with the lightning on and the level dots' colors off (${names(c)})`);
  setSubmapLightning(rom, 1, false);
  setSubmapAnimSettings(rom, 1, 0);
  // the submap's own color animation and rotation are not the game's
  const own: ExList = emptyList();
  own.slots.set(0, { type: 0x14, trigger: 0, framesLess1: 1, dest: 0x21, frames: [0x001f, 0x7c00] });
  const rot = { type: 0x18, trigger: 0, framesLess1: 0, dest: 0, frames: [] };
  setRotationRange(rot, 0x31, 6);
  own.slots.set(1, rot);
  writeSubmapList(rom, 1, own);
  const r = loads().get(1, 0), pal = submapPalette(rom, 1);
  check([0x21, 0x31].every((i) => r.cgram[i * 2] !== pal[i * 2] || r.cgram[i * 2 + 1] !== pal[i * 2 + 1]), 'their colors 21 and 31 differ from the palette after the load');
  const o = owGameColors(loads(), 1, 0, false);
  check(names(o) === names(GAME), `with a color animation of 21 and a rotation of 31–36 on Yoshi's Island: the game's colors only (${names(o)})`);
  writeSubmapList(rom, 1, null);
}

// ---- the event triggers ----
// Anim graphic A: tile k all bytes 0x11 * (k + 1); a slot with trigger 01 (Event Manual 8): 11/22 normally, 33/44
// while its event is passed; trigger 02 (Event Manual 9) without an event in the Trigger Init
const alt = new Uint8Array(0x100);
for (let k = 0; k < 8; k++) alt.fill(0x11 * (k + 1), k * 32, k * 32 + 32);
writeAltFile(rom, 0, alt);
const ppu = loads().get(1, 0).ppuRegs;
const T = ((ppu[0x0b] & 0x0f) << 12) + 0x40 * 16, U = T + 16;
const EVENT = 5;
const list: ExList = emptyList();
list.slots.set(0, { type: 0x01, trigger: 0x01, framesLess1: 1, dest: 0x8000 | T, frames: [0x00, 0x20, 0x40, 0x60] });
list.slots.set(1, { type: 0x01, trigger: 0x02, framesLess1: 1, dest: 0x8000 | U, frames: [0x00, 0x20, 0x40, 0x60] });
list.manual.set(8, EVENT);
writeSubmapList(rom, 1, list);
const shown = (r: { vram: Uint8Array }, word: number) => r.vram[word * 2];
const second = (v: number) => v === 0x33 || v === 0x44, first = (v: number) => v === 0x11 || v === 0x22;
{
  const l = loads(), before = l.get(1, EVENT), after = l.get(1, EVENT + 1);
  const a = eventTriggerState(before.wram, 1), b = eventTriggerState(after.wram, 1), n = eventTriggerState(after.wram, 2);
  check(a.event === EVENT && !a.holds && b.event === EVENT && b.holds, `trigger 01 waits for event ${hx(EVENT)}: not passed at progress ${EVENT}, passed at ${EVENT + 1} (${a.event} ${a.holds}, ${b.event} ${b.holds})`);
  check(n.event === null && !n.holds, 'trigger 02 without an event in the Trigger Init: none, never holds');
  check(first(shown(before, T)) && second(shown(after, T)), `the load shows the first frame set before, the second after (${hx(shown(before, T))}, ${hx(shown(after, T))})`);

  const on = owTriggerRender(l, 1, EVENT, false, [[1, true]]);
  check(second(shown(on, T)) && first(shown(on, U)), `switched on at progress ${EVENT}: trigger 01's second set shows (${hx(shown(on, T))}), trigger 02's not (${hx(shown(on, U))})`);
  check(gameL1(on).every((v, i) => v === gameL1(before)[i]), 'the map\'s layer 1 as at the load');
  const off = owTriggerRender(l, 1, EVENT + 1, false, [[1, false]]);
  check(first(shown(off, T)), `switched off at progress ${EVENT + 1}: its first set (${hx(shown(off, T))})`);
  const none = owTriggerRender(l, 1, 0, false, [[2, true]]);
  check(second(shown(none, U)) && first(shown(none, T)), `trigger 02 (no event) switched on: its second set (${hx(shown(none, U))}), trigger 01 as the progress has it (${hx(shown(none, T))})`);
  const both = owTriggerRender(l, 1, 0, false, [[1, true], [2, true]]);
  check(second(shown(both, T)) && second(shown(both, U)), 'both switched on: both second sets');
  const special = owTriggerRender(l, 1, 0, true, [[1, true]]);
  check(second(shown(special, T)), 'after the special world too');
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
