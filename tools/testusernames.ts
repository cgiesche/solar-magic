// The user's names of things (usernames.ts), for now FG and BG Map16 tiles: at most 64 characters, trimmed,
// an empty name removes it, several tiles may share one. Kept as editor data (outside the ROM image): saved
// with the project file, never in the playable ROM; one ROM edit is one undo step.
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { NAME_MAX, nameOf, namesOf, setName, moveNames, nameGroups, connectedRect, tileRanges } from '../src/core/usernames.ts';
import { cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// set, share, remove, rules
{
  const rom = new Rom(cleanImage());
  check(nameOf(rom, 'fg', 0x200) === null && namesOf(rom, 'fg').size === 0, 'no names at first');
  setName(rom, 'fg', [0x200], 'Bush');
  check(nameOf(rom, 'fg', 0x200) === 'Bush', 'a tile named');
  check(nameOf(rom, 'bg', 0x200) === null, 'FG and BG tiles are named apart');
  setName(rom, 'fg', [0x210, 0x211, 0x220, 0x221], '  Big  bush ');
  check([0x210, 0x211, 0x220, 0x221].every((t) => nameOf(rom, 'fg', t) === 'Big  bush'), 'several tiles share a name, trimmed, inner spaces kept');
  setName(rom, 'fg', [0x211], 'Other');
  check(nameOf(rom, 'fg', 0x211) === 'Other' && nameOf(rom, 'fg', 0x210) === 'Big  bush', 'one name per tile: renaming one leaves the others');
  setName(rom, 'fg', [0x200], '   ');
  check(nameOf(rom, 'fg', 0x200) === null && namesOf(rom, 'fg').size === 4, 'an empty name removes it');
  setName(rom, 'bg', [0x400], 'x'.repeat(100));
  check(nameOf(rom, 'bg', 0x400) === 'x'.repeat(NAME_MAX) && NAME_MAX === 64, 'at most 64 characters');
  setName(rom, 'bg', [0x401], '🍄'.repeat(70));
  check([...nameOf(rom, 'bg', 0x401)!].length === 64, 'characters, not UTF-16 units');
  setName(rom, 'bg', [0x402], 'ÄÖÜ <tag> "q"');
  check(nameOf(rom, 'bg', 0x402) === 'ÄÖÜ <tag> "q"', 'any text, stored as typed');
  for (const k of ['fg', 'bg'] as const) setName(rom, k, [...namesOf(rom, k).keys()], '');
  check(!rom.extra.size, 'no names: no editor data entry');
}

// the playable ROM is unchanged; the project file keeps them
{
  const rom = new Rom(cleanImage());
  const before = rom.output(false);
  setName(rom, 'fg', [0x300, 0x301], 'Pipe');
  setName(rom, 'bg', [0x0a0], 'Hill');
  check(same(rom.output(false), before), 'the playable ROM is unchanged by names');
  const back = Rom.fromFile(rom.outputProject(false));
  check(nameOf(back, 'fg', 0x301) === 'Pipe' && nameOf(back, 'bg', 0x0a0) === 'Hill' && namesOf(back, 'fg').size === 2, 'names survive the project file');
  const plain = Rom.fromFile(rom.output(false));
  check(namesOf(plain, 'fg').size === 0, 'a plain ROM has none');
}

// one ROM edit is one undo step
{
  const rom = new Rom(cleanImage());
  const s = new RomEditSession(rom);
  s.edit('Name', () => setName(rom, 'fg', [0x200, 0x201], 'Door'));
  s.edit('Rename', () => setName(rom, 'fg', [0x200, 0x201], 'Gate'));
  check(s.history.undoStack.length === 2, 'each naming is one undo step');
  s.undo();
  check(nameOf(rom, 'fg', 0x200) === 'Door' && nameOf(rom, 'fg', 0x201) === 'Door', 'undo restores the names');
  s.undo();
  check(nameOf(rom, 'fg', 0x200) === null, 'undo of the first removes them');
  s.redo(); s.redo();
  check(nameOf(rom, 'fg', 0x201) === 'Gate', 'redo restores them');
}

// a tile move takes the names along (swaps work, destinations get the moved tile's name or none)
{
  const rom = new Rom(cleanImage());
  setName(rom, 'fg', [0x200], 'A');
  setName(rom, 'fg', [0x201], 'B');
  setName(rom, 'fg', [0x300], 'Overwritten');
  moveNames(rom, 'fg', new Map([[0x200, 0x201], [0x201, 0x200], [0x202, 0x300]]));
  check(nameOf(rom, 'fg', 0x200) === 'B' && nameOf(rom, 'fg', 0x201) === 'A', 'swapped names');
  check(nameOf(rom, 'fg', 0x300) === null && nameOf(rom, 'fg', 0x202) === null, 'a destination takes the moved tile\'s none');
  setName(rom, 'bg', [0x500], 'Cloud');
  moveNames(rom, 'bg', new Map([[0x500, 0x600]]));
  check(nameOf(rom, 'bg', 0x600) === 'Cloud' && nameOf(rom, 'bg', 0x500) === null, 'the moved-away tile is left without');
}

// grouped by name for the central search: one group per name, however many tiles and wherever they lie
{
  const names = new Map([[0x221, 'Bush'], [0x210, 'Bush'], [0x300, 'apple'], [0x211, 'Bush'], [0x220, 'Bush'], [0x5ff, 'Bush ']]);
  const g = nameGroups(names);
  check(g.length === 3, 'one group per name');
  check(JSON.stringify(g.map((x) => x.name)) === JSON.stringify(['apple', 'Bush', 'Bush ']), 'ordered by name, any case; names differing only in spaces stay apart');
  check(JSON.stringify(g[1].tiles) === JSON.stringify([0x210, 0x211, 0x220, 0x221]), 'a group\'s tiles ascending');
  check(nameGroups(new Map()).length === 0, 'no names, no groups');
}

// the rectangle around connected tiles (16 per row on the sheet)
{
  const rect = (t: number[]) => JSON.stringify(connectedRect(t));
  check(rect([0x210, 0x211, 0x220, 0x221]) === JSON.stringify({ first: 0x210, w: 2, h: 2 }), 'a block of 2x2 tiles');
  check(rect([0x200]) === JSON.stringify({ first: 0x200, w: 1, h: 1 }), 'a single tile');
  check(rect([0x211, 0x220, 0x221]) === JSON.stringify({ first: 0x210, w: 2, h: 2 }), 'an L shape: its bounding rectangle');
  check(connectedRect([0x200, 0x202]) === null, 'tiles apart are not connected');
  check(connectedRect([0x20f, 0x210]) === null, 'the end of a row does not touch the start of the next');
  check(connectedRect([0x210, 0x221]) === null, 'diagonal neighbours are not connected');
  check(connectedRect([]) === null, 'no tiles');
}

// the numbers as shown: runs of consecutive tiles as ranges
check(tileRanges([0x210, 0x211, 0x212, 0x220, 0x300, 0x301]) === '210–212, 220, 300–301', 'tile numbers in runs');

console.log(bad ? `${bad} FAILED` : 'all ok');
if (bad) process.exit(1);
