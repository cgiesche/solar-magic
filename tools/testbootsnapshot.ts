// The boot snapshot and what a result shows (bootsnapshot.ts), without booting a ROM: a snapshot built from given
// read sets and a stand-in for the recording CPU.
// - which of the boot's and its own reads a result counts, by what it shows: as a table, the kind of byte changed ×
//   behaviour / picture / full picture / title screen → kept or dropped
// - what a result leaves out besides: the colours' values (a full picture, the boot's reads too), the overworld's data
//   (behaviour, its own reads only), the tile data while the tilesets' pointers are learned (on top of nothing)
// - what the reads are put on top of (the boot's, nothing, an earlier result's) and whether they count around it
// - the snapshot holds for a ROM image or is stale; emulators share it by reference
// - the title screen picture put back into a kept result's machine
import { Rom, pcToSnes } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { RomReads, record, holds } from '../src/core/romdeps.ts';
import { BootSnapshot, recordShown, leaving, type Shows, type ShowingCpu, type RecordOn, type Places, type LeftOut, type BootReads } from '../src/core/bootsnapshot.ts';
import { L3_MAP_VRAM, L3_MAP_WORDS } from '../src/core/layer3map.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };

// a blank image: no patch, no table of the game's, every read on a page of its own (ROM offsets)
const rom = new Rom(new Uint8Array(0x80000));
const BOOT_CODE = 0x10000, OWN_CODE = 0x11000, BOOT_GFX = 0x20000, OWN_GFX = 0x21000, BOOT_ANIM = 0x22000, OWN_ANIM = 0x23000;
const PICTURE = 0x30000, UNTOUCHED = 0x40000, BOOT_DISPLAY = 0x50000, OWN_DISPLAY = 0x51000, BOOT_COLOUR = 0x52000, OWN_COLOUR = 0x53000;
const BOOT_OW = 0x60000, OWN_OW = 0x61000;
// where the bytes lie a result leaves out by what it shows: a picture the graphics file and ExAnimation data,
// behaviour the display data (the colours among it) too
const filled = (...ranges: [number, number][]) => { const m = new Uint8Array(rom.data.length); for (const [a, b] of ranges) m.fill(1, a, b); return m; };
const mask = filled([0x20000, 0x24000]), displayMask = filled([0x20000, 0x24000], [0x50000, 0x54000]);
const where: Places = { picture: () => mask, behaviour: () => displayMask };
// what results leave out besides: the colours' values with the graphics file data (in the boot's reads too), the
// overworld's data, the display data while the tilesets' pointers are learned
const COLOURS: LeftOut = { what: 'colours', mask: () => filled([0x20000, 0x22000], [0x52000, 0x54000]), boot: true };
const OVERWORLD: LeftOut = { what: 'overworld', mask: () => filled([0x60000, 0x62000]) };
const TILE_DATA: LeftOut = { what: 'tile data', mask: () => displayMask };

// the recording CPU's stand-in: a read as Snes records it (the skip mask's bytes apart, when asked for)
class Cpu implements ShowingCpu {
  romReads: RomReads | null = null;
  romSkipMask: Uint8Array | null = null;
  romMasked: RomReads | null = null;
  read(o: number): void {
    if (!this.romReads) return;
    if (this.romSkipMask?.[o] === 1) { this.romMasked?.read(o); return; }
    this.romReads.read(o);
  }
}

const reads = (...at: number[]) => { const r = new RomReads(rom); for (const o of at) r.read(o); return r; };
// the boot read code, graphics file and ExAnimation data, display data (a colour among it), overworld data and the
// title screen picture; booted for a picture
const snapshotOf = (vram = new Uint8Array(0x10000)) =>
  new BootSnapshot({ state: { vram }, rom: rom.data.slice(), leaves: 'picture', reads: reads(BOOT_CODE, BOOT_DISPLAY, BOOT_COLOUR, BOOT_OW), masked: reads(BOOT_GFX, BOOT_ANIM), picture: reads(PICTURE) });
// the same boot run once more, its reads recorded leaving out other bytes (as LevelEmulator boots again)
const AGAIN: Record<string, BootReads> = {
  behaviour: { reads: reads(BOOT_CODE, BOOT_OW), masked: reads(BOOT_GFX, BOOT_ANIM, BOOT_DISPLAY, BOOT_COLOUR) },
  'full picture+colours': { reads: reads(BOOT_CODE, BOOT_DISPLAY, BOOT_OW, BOOT_ANIM), masked: reads(BOOT_GFX, BOOT_COLOUR) },
};
let boots = 0;
const again = (leaves: string) => () => { boots++; return AGAIN[leaves]; };
const SHOWS: Shows[] = ['behaviour', 'picture', 'full picture', 'title screen'];

// a result starting from the snapshot whose code reads a byte of its own of every kind; kept: the ROM changed at `o`
// since, it still holds
const snap = snapshotOf(), cpu = new Cpu();
const shown = (shows: Shows, on: RecordOn, snapshot: () => BootSnapshot | null) => {
  const l = leaving(rom, shows, where, on.leavesOut);
  return { ...on, leaving: l, snapshot, again: again(l.boot) };
};
const result = (shows: Shows, on: RecordOn = {}) =>
  recordShown(rom, cpu, shows, () => { for (const o of [OWN_CODE, OWN_GFX, OWN_ANIM, OWN_DISPLAY, OWN_COLOUR, OWN_OW]) cpu.read(o); return 0; }, shown(shows, on, () => snap));
const kept = (shows: Shows, o: number, on: RecordOn = {}): boolean => {
  const r = result(shows, on);
  rom.writeAt(o, Uint8Array.of(rom.data[o] ^ 0xff));
  const ok = holds(rom, r);
  rom.writeAt(o, Uint8Array.of(rom.data[o] ^ 0xff));
  return ok;
};

// the kind of byte changed × what the result shows (behaviour, picture, full picture, title screen): 1 kept, 0 dropped
const TABLE: [string, number, string][] = [
  ['code the boot ran', BOOT_CODE, '0000'],
  ['code the result ran', OWN_CODE, '0000'],
  ['display data the boot read', BOOT_DISPLAY, '1000'],
  ['display data the result read', OWN_DISPLAY, '1000'],
  ['a colour the boot read', BOOT_COLOUR, '1000'],
  ['graphics file data the boot read', BOOT_GFX, '1100'],
  ['graphics file data the result read', OWN_GFX, '1100'],
  ['ExAnimation data the boot read', BOOT_ANIM, '1100'],
  ['ExAnimation data the result read', OWN_ANIM, '1100'],
  ['the title screen picture', PICTURE, '1110'],
  ['a byte nothing read', UNTOUCHED, '1111'],
];
for (const [what, o, want] of TABLE) {
  const got = SHOWS.map((s) => kept(s, o) ? '1' : '0').join('');
  check(got === want, `${what} changed: ${SHOWS.map((s, i) => `${s} ${want[i] === '1' ? 'kept' : 'dropped'}`).join(', ')} (${got})`);
}
check(cpu.romReads === null && cpu.romSkipMask === null && cpu.romMasked === null, 'the CPU records nothing after a result');
check(boots === 1, `the boot's reads without the display data: of the boot run once more, kept with the snapshot (${boots} more boots)`);

// what a result leaves out besides, the kind of byte changed → kept (1) or dropped (0)
const BESIDES: [string, Shows, RecordOn, [string, number, boolean][]][] = [
  // (where the colours are loaded from: the ExAnimation data counts, the colours' values and the graphics files don't)
  ['a full picture leaving out the colours\' values, in the boot\'s reads too', 'full picture', { leavesOut: COLOURS }, [
    ['a colour the boot read', BOOT_COLOUR, true], ['a colour it read', OWN_COLOUR, true], ['graphics file data', BOOT_GFX, true], ['graphics file data it read', OWN_GFX, true],
    ['ExAnimation data the boot read', BOOT_ANIM, false], ['ExAnimation data it read', OWN_ANIM, false], ['other display data the boot read', BOOT_DISPLAY, false],
    ['other display data it read', OWN_DISPLAY, false], ['code the boot ran', BOOT_CODE, false], ['code it ran', OWN_CODE, false], ['the title screen picture', PICTURE, true],
  ]],
  // (the path kinds: the boot's reads count as for any behaviour)
  ['behaviour leaving out the overworld\'s data', 'behaviour', { leavesOut: OVERWORLD }, [
    ['overworld data it read', OWN_OW, true], ['overworld data the boot read', BOOT_OW, false], ['display data it read', OWN_DISPLAY, true], ['display data the boot read', BOOT_DISPLAY, true],
    ['graphics file data it read', OWN_GFX, true], ['code the boot ran', BOOT_CODE, false], ['code it ran', OWN_CODE, false],
  ]],
  // (the tilesets' pointers: a picture's recording, since what behaviour leaves out needs them; on top of nothing)
  ['a picture leaving out the tile data, on top of nothing', 'picture', { leavesOut: TILE_DATA, base: null }, [
    ['display data it read', OWN_DISPLAY, true], ['a colour it read', OWN_COLOUR, true], ['graphics file data it read', OWN_GFX, true], ['code it ran', OWN_CODE, false],
    ['overworld data it read', OWN_OW, false], ['code the boot ran', BOOT_CODE, true], ['display data the boot read', BOOT_DISPLAY, true],
  ]],
];
for (const [what, shows, on, rows] of BESIDES) {
  const wrong = rows.filter(([, o, want]) => kept(shows, o, on) !== want).map(([w]) => w);
  check(wrong.length === 0, `${what}: ${rows.map(([w, , k]) => `${w} ${k ? 'kept' : 'dropped'}`).join(', ')}${wrong.length ? ` – WRONG: ${wrong.join(', ')}` : ''}`);
}
check(kept('full picture', OWN_OW, { leavesOut: OVERWORLD }) && !kept('full picture', OWN_GFX, { leavesOut: OVERWORLD }) && !kept('full picture', BOOT_GFX, { leavesOut: OVERWORLD }),
  'a full picture leaving out bytes besides leaves out those only: the graphics file data counts, its own and the boot\'s');
check(cpu.romReads === null && cpu.romSkipMask === null && cpu.romMasked === null, 'the CPU records nothing after such a result');

// what the reads are put on top of
check(kept('title screen', BOOT_CODE, { base: null }) && kept('title screen', BOOT_GFX, { base: null }) && kept('title screen', PICTURE, { base: null }),
  'on top of nothing: none of the boot\'s reads count, whatever it shows');
check(!kept('behaviour', OWN_CODE, { base: null }) && kept('behaviour', OWN_GFX, { base: null }) && !kept('full picture', OWN_GFX, { base: null }),
  'on top of nothing: its own reads count by what it shows');
const earlier = reads(UNTOUCHED);
check(!kept('behaviour', UNTOUCHED, { base: earlier }) && kept('behaviour', BOOT_CODE, { base: earlier }) && !earlier.touches([[OWN_CODE, OWN_CODE + 1]]),
  'on top of an earlier result\'s reads: they count instead of the boot\'s, and are left as they were');

// whether the reads count for the recording around it
const around = (on: RecordOn) => record(rom, () => result('title screen', on), { cpu, mask: () => mask }).reads;
const at = (o: number): [number, number][] => [[o, o + 1]];
check(around({}).touches(at(OWN_CODE)) && !around({ counted: false }).touches(at(OWN_CODE)), 'its reads count for the recording around it, unless not counted');
check(!around({}).touches(at(OWN_GFX)) && !around({}).touches(at(PICTURE)), 'the recording around it says itself what it shows: it gets no read its own mask leaves out');
const outer = new RomReads(rom);
cpu.romMasked = outer;
result('full picture');
check(cpu.romMasked === outer && !outer.touches(at(OWN_GFX)), 'the reads the mask leaves out are recorded for the result, and the recorder around it put back');
cpu.romMasked = null;

// a snapshot asked for again after the run: a result that boots inside counts the snapshot booted there
{
  let booted: BootSnapshot | null = null;
  const r = recordShown(rom, cpu, 'title screen', () => { booted = snap; return 0; }, shown('title screen', {}, () => booted));
  check(r.reads.touches(at(BOOT_CODE)) && r.reads.touches(at(BOOT_GFX)) && r.reads.touches(at(PICTURE)), 'booted inside the recording: the boot\'s reads count by what the result shows');
}

// the snapshot holds for a ROM image or is stale
{
  const changed = (o: number) => { const d = rom.data.slice(); d[o] ^= 0xff; return d; };
  check(snap.holds(rom.data) && snap.holds(changed(UNTOUCHED)) && snap.holds(changed(OWN_CODE)), 'the snapshot holds while no byte the boot read changed');
  check(!snap.holds(changed(BOOT_CODE)) && !snap.holds(changed(BOOT_GFX)) && !snap.holds(changed(PICTURE)),
    'stale when code the boot ran, graphics file data it read or the title screen picture changed');
}

// emulators share it by reference; an emulator's recording is the same (the editor code's reads here)
{
  const a = new LevelEmulator(rom), b = new LevelEmulator(rom);
  a.adoptBoot(snap); b.adoptBoot(a.snapshot);
  check(a.snapshot === snap && b.snapshot === snap, 'taken over: one snapshot for both emulators');
  const own = pcToSnes(OWN_CODE), by = (shows: Shows) => a.record(shows, () => rom.r8(own)).reads;
  check(SHOWS.every((s) => by(s).touches(at(OWN_CODE)) && by(s).touches(at(BOOT_CODE))) && !by('picture').touches(at(BOOT_GFX)) && by('full picture').touches(at(BOOT_GFX))
    && !by('full picture').touches(at(PICTURE)) && by('title screen').touches(at(PICTURE)), 'an emulator\'s recording counts the snapshot\'s reads by what the result shows');
  check(!a.record('title screen', () => rom.r8(own), { base: null }).reads.touches(at(BOOT_CODE)), 'and on top of nothing none of them');
}

// the picture put back: the cells of layer 3's tilemap a kept result left as it started get the picture as booted
{
  const A = L3_MAP_VRAM * 2, cells = (v: Uint8Array, ...i: number[]) => i.map((k) => v[A + k * 2] | (v[A + k * 2 + 1] << 8)).join();
  const set = (v: Uint8Array, k: number, w: number) => { v[A + k * 2] = w & 0xff; v[A + k * 2 + 1] = w >> 8; };
  const first = new Uint8Array(0x10000), now = new Uint8Array(0x10000);
  for (let k = 0; k < L3_MAP_WORDS; k++) { set(first, k, 0x1000 + k); set(now, k, 0x2000 + k); } // the picture as booted then and now
  first[A - 2] = now[A - 1] = first[A + L3_MAP_WORDS * 2] = 7; // (outside the tilemap)
  const machine = first.slice();
  set(machine, 5, 0x3abc); // what the result drew: a whole cell, and one byte of another
  machine[A + 9 * 2] ^= 0xff;
  const drawn = cells(machine, 5, 9), before = machine.slice();
  snapshotOf(now).putPictureBack(machine, first);
  check(cells(machine, 0, 4, 6, L3_MAP_WORDS - 1) === cells(now, 0, 4, 6, L3_MAP_WORDS - 1), 'put back: the cells left as they were show the picture as booted');
  check(cells(machine, 5, 9) === drawn, 'the cells the result drew stay');
  check(machine.subarray(0, A).every((v, i) => v === before[i]) && machine.subarray(A + L3_MAP_WORDS * 2).every((v, i) => v === before[A + L3_MAP_WORDS * 2 + i]), 'nothing outside layer 3\'s tilemap changes');
  const same = first.slice();
  snapshotOf(first).putPictureBack(same, first);
  check(same.every((v, i) => v === first[i]), 'the picture not painted: the machine as it was');
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
