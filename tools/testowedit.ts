// Overworld changes are ROM edits: a paint stroke is one undo step; layer 1 changes only the bytes of the painted
// tiles, layer 2 stays where it is when it fits (each stream in its own place, the other untouched) and moves to
// free space only otherwise; the game shows the painted map (emulated).
import { Rom, snesToPc, pcToSnes } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { OverworldEmulator, OverworldLoads, readL1, writeL1, readL2, writeL2, l1Index, l2Index, l2Pointers, OW_L1 } from '../src/core/overworld.ts';
import { levelNameTiles, setLevelNameTiles, encodeName } from '../src/core/levelnames.ts';
import { RAM, getS16 } from '../src/core/ram.ts';
import { submapViews } from '../src/core/owevents.ts';
import { editorPatch } from '../src/core/patches.ts';
import { RomReads, PAGE_SHIFT } from '../src/core/romdeps.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const image = await editorImage();
const fresh = () => { const rom = new Rom(image.slice()); return { rom, s: new RomEditSession(rom) }; };
// the file offsets where two images differ
// the ROM's layer 2, its first 0x1000 entries noise (no runs: grows past its place)
const noisyL2 = (rom: Rom) => {
  const l2 = readL2(rom);
  let seed = 1;
  for (let k = 0; k < 0x1000; k++) { seed = (seed * 1103515245 + 12345) >>> 0; l2[k] = (seed >>> 8) & 0x3fff; }
  return l2;
};
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
  const l2 = noisyL2(rom);
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
  const was = levelNameTiles(rom, 1), next = encodeName('MY LEVEL').tiles;
  s.edit('Level name 001', () => setLevelNameTiles(rom, 1, next));
  check(s.history.undoStack.length === 1 && levelNameTiles(rom, 1).join() === [...next, ...Array(19 - next.length).fill(0x1f)].join(), 'level name: a ROM edit');
  s.undo();
  check(levelNameTiles(rom, 1).join() === was.join(), 'level name undone');
}

// the game shows the painted map: layer 1 in its tilemap in WRAM, layer 2 in VRAM
{
  const { rom } = fresh();
  const emu = new OverworldEmulator(rom);
  const r0 = emu.load(0, 0);
  const l1 = readL1(rom), l2 = readL2(rom);
  const i1 = l1Index(0, 7, 9), i2 = l2Index(0, 21, 40);
  l1[i1] = l1[i1] === 0x56 ? 0x57 : 0x56;
  l2[i2] = l2[i2] === 0x0123 ? 0x0124 : 0x0123;
  writeL1(rom, l1);
  writeL2(rom, l2);
  const r = emu.load(0, 0);
  check(r0.ok && r.ok, 'overworld loads');
  check(r.wram[RAM.owLayer1 + i1] === l1[i1], 'the game\'s layer 1 has the painted tile');
  const base = (r.ppuRegs[0x08] & 0xfc) << 9; // BG2SC: the layer 2 tilemap
  const word = (v: Uint8Array, k: number) => v[base + k * 2] | (v[base + k * 2 + 1] << 8);
  check(word(r0.vram, i2) !== l2[i2] && word(r.vram, i2) === l2[i2], 'the game\'s layer 2 has the painted entry');
  check(Array.from({ length: 0x1000 }, (_, k) => k).every((k) => word(r.vram, k) === l2[k]), 'the game\'s layer 2 is the painted map');
}

// a kept load stays while a ROM edit changes no byte it read (a level's graphics), painting the map loads it again
{
  const { rom, s } = fresh();
  const loads = new OverworldLoads(new OverworldEmulator(rom), 4);
  const r0 = loads.get(0, 0), r5 = loads.get(0, 5);
  const gfx = editorPatch(rom)!.levelGfx + 0x105 * 8;
  s.edit('Level 105 graphics', () => rom.w8(gfx, rom.r8(gfx) ^ 1));
  check(loads.get(0, 0) === r0 && loads.get(0, 5) === r5, 'a ROM edit no load read: the loads kept (no emulation)');
  const l1 = readL1(rom), i = l1Index(0, 7, 9);
  l1[i] = l1[i] === 0x56 ? 0x57 : 0x56;
  s.edit('Paint layer 1', () => writeL1(rom, l1));
  const r = loads.get(0, 0);
  check(r !== r0 && r.wram[RAM.owLayer1 + i] === l1[i], 'painting layer 1: loaded again, with the painted tile');
  check(loads.get(0, 5) !== r5, 'painting layer 1: the other event progress loaded again');
  s.undo();
  check(loads.get(0, 0).wram[RAM.owLayer1 + i] === r0.wram[RAM.owLayer1 + i], 'undone: loaded again, the tile as before');
}

// the submaps' views from the kept loads: as each submap's load shows them, shown again without emulating while the
// ROM edits changed nothing they read
{
  const { rom, s } = fresh();
  const emu = new OverworldEmulator(rom), loads = new OverworldLoads(emu, 2);
  let loaded = 0;
  const loadRecorded = emu.loadRecorded.bind(emu);
  emu.loadRecorded = (map, progress) => { loaded++; return loadRecorded(map, progress); };
  // each submap's camera as its own load leaves it
  const direct = () => {
    const e = new OverworldEmulator(new Rom(rom.data.slice()));
    return [1, 2, 3, 4, 5, 6].map((k) => { const w = e.load(k, 0).wram; return `${Math.round(getS16(w, RAM.layer2X) / 8)},${Math.round(getS16(w, RAM.layer2Y) / 8)}`; }).join(' ');
  };
  const text = (v: ReturnType<typeof submapViews>) => v.slice(1).map((r) => `${r.x},${r.y}`).join(' ');
  const r0 = loads.get(0, 0), r1 = loads.get(1, 0);
  loaded = 0;
  const v = submapViews(loads), want = direct();
  check(loaded === 5 && text(v) === want, `the submaps' views: ${text(v)} (each submap's load: ${want}), ${loaded} loads (submap 1's kept)`);
  loaded = 0;
  check(submapViews(loads) === v && loaded === 0, 'asked again: the kept views, no load');
  const gfx = editorPatch(rom)!.levelGfx + 0x105 * 8;
  s.edit('Level 105 graphics', () => rom.w8(gfx, rom.r8(gfx) ^ 1));
  check(submapViews(loads) === v && loaded === 0, 'a ROM edit no load read: the kept views, no load');
  check(loads.get(0, 0) === r0 && loads.get(1, 0) === r1 && loaded === 0, 'the loads kept before stay kept: no load');
  const l1 = readL1(rom), i = l1Index(1, 7, 9);
  l1[i] = l1[i] === 0x56 ? 0x57 : 0x56;
  s.edit('Paint layer 1', () => writeL1(rom, l1));
  loaded = 0;
  const v2 = submapViews(loads);
  check(v2 !== v && loaded === 6 && text(v2) === direct(), `painting layer 1: loaded again (${loaded} loads), the same views`);
}

// layer 2 moved to free space: the loads record its new place by byte (no title screen reached again in between), an
// edit next to it they didn't read keeps them; an outer read recorder survives a load that reaches the title screen
{
  const { rom, s } = fresh();
  const emu = new OverworldEmulator(rom), outer = new RomReads(rom);
  emu.snes.romReads = outer;
  emu.load(0, 0);
  check(emu.snes.romReads === outer && outer.bytes.has(snesToPc(OW_L1)), 'reaching the title screen: the outer recorder put back, with the load\'s reads');
  emu.snes.romReads = null;
  const loads = new OverworldLoads(emu, 4);
  const l2 = noisyL2(rom);
  s.edit('Paint layer 2', () => writeL2(rom, l2));
  const r0 = loads.get(0, 0);
  const attrs = snesToPc(l2Pointers(rom).attrs), block = rom.scanRats().find((b) => b.start + 8 <= attrs && attrs < b.start + 8 + b.size)!;
  const end = block.start + 8 + block.size, next = end + 0x10; // free space after the block, in its last page
  check(next >> PAGE_SHIFT === (end - 1) >> PAGE_SHIFT, 'layer 2, moved: free space next to it in its page');
  s.edit('Free space next to layer 2', () => rom.w8(pcToSnes(next), rom.data[next] ^ 1));
  check(loads.get(0, 0) === r0, 'layer 2, moved: an edit next to it the load didn\'t read keeps it (no emulation)');
  l2[l2Index(0, 5, 5)] ^= 0x0001;
  s.edit('Paint layer 2', () => writeL2(rom, l2));
  check(loads.get(0, 0) !== r0, 'layer 2, moved: painting it loads again');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('overworld edits ok');
