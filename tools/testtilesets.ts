// Which tilesets share a Map16 tile's data (tilesets.ts): the pointers each tileset loads, learned by
// emulation, checked against the clean game's levels.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel } from '../src/core/level.ts';
import { map16Pointer } from '../src/core/ram.ts';
import { usedLevels } from '../src/core/levelusage.ts';
import { TILESETS, tilesetPointers, sharingTilesets } from '../src/core/tilesets.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fail++; };
const hex = (n: number) => n.toString(16).toUpperCase();

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom); emu.boot();
const runs = Array.from({ length: TILESETS }, (_, ts) => tilesetPointers(emu, ts));
const ptrs = runs.map((r) => r.result);

// every level of the game loads the pointers of its tileset for 073-0FF (some levels swap standard
// tiles of their own: 109 has other 133-13A)
{
  const bad: string[] = [], seen = new Set<number>();
  for (const n of usedLevels(rom)) {
    const ts = loadLevel(rom, n).header.tileset, w = emu.load(n).wram;
    seen.add(ts);
    for (let t = 0x73; t < 0x100; t++) if (map16Pointer(w, t) !== ptrs[ts][t]) bad.push(`${hex(n)}:${hex(t)}`);
  }
  check(bad.length === 0, `every level's pointers of tiles 073-0FF are its tileset's (${[...seen].map(hex).join(' ')}) ${bad.slice(0, 8).join(' ')}`);
}

// the groups of tilesets sharing the tileset tiles 073-0FF
{
  const groups = new Set<string>();
  for (let ts = 0; ts < TILESETS; ts++) for (let t = 0x73; t < 0x100; t++) groups.add(sharingTilesets(ptrs, ts, t).map(hex).join(','));
  const want = ['0,7,C', '1', '2,6,8', '3,9,A,B,E', '4,5,D', 'F'];
  check([...groups].sort().join(' ') === want.join(' '), `groups: ${[...groups].sort().join(' ')}`);
  check(sharingTilesets(ptrs, 7, 0x80).join() === '0,7,12', 'tile 080 of tileset 7 is that of tilesets 0, 7, C');
  check(sharingTilesets(ptrs, 1, 0xff).join() === '1', 'tile 0FF of tileset 1 is its own');
  check(sharingTilesets(ptrs, 3, 0x100).length === TILESETS && sharingTilesets(ptrs, 3, 0x72).length === TILESETS, 'standard tiles 000-072 and 100-1FF: all tilesets');
}

// within a tileset (of the levels) no two tiles share data
{
  const dup = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xa, 0xb, 0xc, 0xd, 0xe].filter((ts) => new Set(ptrs[ts]).size !== 0x200);
  check(dup.length === 0, `no shared data within a tileset ${dup.map(hex).join(' ')}`);
}

// editing a tile's data keeps the pointers valid
{
  const before = rom.data.slice(), a = snesToPc(0x0d0000 | ptrs[0][0x80]);
  rom.w16(0x0d0000 | ptrs[0][0x80], rom.r16(0x0d0000 | ptrs[0][0x80]) ^ 0x4000);
  check(rom.data[a + 1] !== before[a + 1] && !runs[0].reads.differ(before, rom.data), 'a tile edit keeps the result');
  rom.data.set(before);
}

// learning the pointers sets its own mask for the load and restores the emulator's (withSkipMask), after an
// exception too
{
  const own = () => null;
  emu.skipMask = own;
  tilesetPointers(emu, 0);
  check(emu.skipMask === own, "the emulator's mask is restored after learning the pointers");
  let seen: Uint8Array | null = null, thrown = false;
  try { emu.withSkipMask(new Uint8Array(1), () => { seen = emu.skipMask!(); throw new Error('x'); }); } catch { thrown = true; }
  check(thrown && seen !== null && emu.skipMask === own, 'the previous mask is restored after an exception');
  emu.skipMask = null;
}

console.log(fail ? `${fail} FAILED` : 'all ok');
process.exit(fail ? 1 : 0);
