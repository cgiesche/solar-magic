// Overworld changes are ROM edits: a paint stroke is one undo step; layer 1 changes only the bytes of the painted
// tiles, layer 2 stays where it is when it fits (each stream in its own place, the other untouched) and moves to
// free space only otherwise; the game shows the painted map (emulated).
import { Rom, snesToPc } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { OverworldEmulator, readL1, writeL1, readL2, writeL2, l1Index, l2Index, l2Pointers, OW_L1, setNameCode, nameCode } from '../src/core/overworld.ts';
import { RAM } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const image = await editorImage();
const fresh = () => { const rom = new Rom(image.slice()); return { rom, s: new RomEditSession(rom) }; };
// the file offsets where two images differ
const diff = (a: Uint8Array, b: Uint8Array) => { const out: number[] = []; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i); return out; };

// layer 1: one stroke of three tiles, one undo step that changes their bytes only
{
  const { rom, s } = fresh();
  const before = rom.data.slice();
  const l1 = readL1(rom);
  const cells = [[3, 4], [4, 4], [20, 30]].map(([x, y]) => l1Index(0, x, y));
  for (const i of cells) l1[i] = l1[i] === 0x10 ? 0x11 : 0x10;
  s.edit('Paint layer 1', () => writeL1(rom, l1), { key: null });
  check(s.history.undoStack.length === 1, 'layer 1 stroke: one undo step');
  check(same(diff(before, rom.data), cells.map((i) => snesToPc(OW_L1) + i).sort((a, b) => a - b)), 'layer 1 stroke: only the painted tiles\' bytes changed');
  s.undo();
  check(same(rom.data, before), 'layer 1 stroke undone');
  s.redo();
  check(same(readL1(rom), l1), 'layer 1 stroke redone');
  const n = s.history.undoStack.length, gen = rom.gen;
  s.edit('Paint layer 1', () => writeL1(rom, readL1(rom)));
  check(s.history.undoStack.length === n && rom.gen === gen, 'a stroke that changes nothing: no undo step, no new ROM generation');
}

// layer 2: a small change stays in place; only the stream that changed is written
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), p = l2Pointers(rom);
  const l2 = readL2(rom);
  const i = l2Index(0, 10, 12);
  l2[i] = (l2[i] & 0xff00) | ((l2[i] + 1) & 0xff); // the tile number only
  s.edit('Paint layer 2', () => writeL2(rom, l2));
  const q = l2Pointers(rom);
  check(q.tiles === p.tiles && q.attrs === p.attrs, 'layer 2, small change: both streams where they were');
  check(same(readL2(rom), l2), 'layer 2, small change: read back as painted');
  const changed = diff(before, rom.data);
  check(changed.length > 0 && changed.every((o) => o >= snesToPc(p.tiles) && o < snesToPc(p.attrs)), 'layer 2, tile change: only the tile stream written');
  s.undo();
  check(same(rom.data, before), 'layer 2 stroke undone');
}

// layer 2: data that doesn't fit moves to free space; a later small change stays there; undo brings all back
{
  const { rom, s } = fresh();
  const before = rom.data.slice(), p = l2Pointers(rom);
  const l2 = readL2(rom);
  let seed = 1;
  for (let k = 0; k < 0x1000; k++) { seed = (seed * 1103515245 + 12345) >>> 0; l2[k] = (seed >>> 8) & 0x3fff; } // (no runs: grows)
  s.edit('Paint layer 2', () => writeL2(rom, l2));
  const q = l2Pointers(rom);
  check(q.tiles !== p.tiles && snesToPc(q.tiles) >= 0x80000, 'layer 2, grown: moved to free space');
  check(same(readL2(rom), l2), 'layer 2, grown: read back as painted');
  l2[l2Index(1, 5, 5)] ^= 0x0001;
  s.edit('Paint layer 2', () => writeL2(rom, l2));
  const r = l2Pointers(rom);
  check(r.tiles === q.tiles && r.attrs === q.attrs, 'layer 2, moved: a small change stays in its block');
  check(same(readL2(rom), l2), 'layer 2, moved: read back as painted');
  l2[l2Index(1, 6, 5)] = 0x2100; // the attributes, too
  s.edit('Paint layer 2', () => writeL2(rom, l2));
  check(same(readL2(rom), l2), 'layer 2, moved: an attribute change read back as painted');
  s.undo(); s.undo(); s.undo();
  check(same(rom.data, before), 'layer 2: the move undone');
}

// a level name: one undo step
{
  const { rom, s } = fresh();
  const code = nameCode(rom, 1);
  s.edit('Level name 001', () => setNameCode(rom, 1, code ^ 0x0011));
  check(s.history.undoStack.length === 1 && nameCode(rom, 1) === (code ^ 0x0011), 'level name: a ROM edit');
  s.undo();
  check(nameCode(rom, 1) === code, 'level name undone');
}

// the game shows the painted map: layer 1 in its tilemap in WRAM, layer 2 in VRAM
{
  const { rom } = fresh();
  const emu = new OverworldEmulator(rom);
  const r0 = emu.load(0, false);
  const l1 = readL1(rom), l2 = readL2(rom);
  const i1 = l1Index(0, 7, 9), i2 = l2Index(0, 21, 40);
  l1[i1] = l1[i1] === 0x56 ? 0x57 : 0x56;
  l2[i2] = l2[i2] === 0x0123 ? 0x0124 : 0x0123;
  writeL1(rom, l1);
  writeL2(rom, l2);
  const r = emu.load(0, false);
  check(r0.ok && r.ok, 'overworld loads');
  check(r.wram[RAM.owLayer1 + i1] === l1[i1], 'the game\'s layer 1 has the painted tile');
  const base = (r.ppuRegs[0x08] & 0xfc) << 9; // BG2SC: the layer 2 tilemap
  const word = (v: Uint8Array, k: number) => v[base + k * 2] | (v[base + k * 2 + 1] << 8);
  check(word(r0.vram, i2) !== l2[i2] && word(r.vram, i2) === l2[i2], 'the game\'s layer 2 has the painted entry');
  check(Array.from({ length: 0x1000 }, (_, k) => k).every((k) => word(r.vram, k) === l2[k]), 'the game\'s layer 2 is the painted map');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('overworld edits ok');
