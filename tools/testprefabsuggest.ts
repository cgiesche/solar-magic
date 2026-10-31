// Prefab suggestions (prefabsuggest.ts, #116): connected groups of Direct Map16 objects that occur more than
// once across the levels (however split into rectangles), with their places, levels and the bytes a prefab
// would save (the level data of the places against one prefab object each, the prefab's ROM cost taken off);
// only positive savings, the largest first. Computed in steps (a generator), so it runs in the background;
// gone once the places are replaced by the prefab. Each level's arrangements and places are kept between runs
// (KeptSuggestions, #185): a run takes apart only the levels that changed, with the same suggestions; a cold run keeps
// all its places for the next one, also more than the bound (#200). A run loads only the levels whose load read a
// changed byte, and a change nothing of the latest run read keeps its suggestions (KeptSuggestions.held, #201), as
// do an undo back to its state and another level opened without edits (#212).
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, newUid, hasObjects, L1_PTRS, type LevelObject } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { usedLevels } from '../src/core/levelusage.ts';
import { DM16_EXT } from '../src/core/patches.ts';
import { installPrefabPatch, writePrefab } from '../src/core/prefabs.ts';
import { prefabCost } from '../src/core/prefabcost.ts';
import { applyPrefabPlaces } from '../src/core/prefabplaces.ts';
import { dm16Groups, prefabSuggestions, suggestPrefabs, KeptSuggestions } from '../src/core/prefabsuggest.ts';
import { RomFingerprint, RomReads } from '../src/core/romdeps.ts';
import { gfxSkipMask } from '../src/core/gfxpages.ts';
import { readGfx, writeGfx } from '../src/core/gfxfiles.ts';
import type { Level } from '../src/core/level.ts';
import { SHARED_PALETTES } from '../src/core/sharedpal.ts';
import { editorImage } from './fixture.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { if (!ok) { fail++; console.log('FAIL', what); } };

const dm = (x: number, y: number, tile: number, w = 1, h = 1): LevelObject =>
  ({ uid: newUid(), num: 0, ext: DM16_EXT, x, y, size: ((h - 1) << 4) | (w - 1), tile });
// a 3×3 block of 9 different tiles as 9 objects: pays off at once
const block = (x: number, y: number) => Array.from({ length: 9 }, (_, i) => dm(x + (i % 3), y + Math.floor(i / 3), 0x100 + i));
// the same block split otherwise: the top row's tiles first
const blockSplit = (x: number, y: number) => [...block(x, y).slice(3), ...block(x, y).slice(0, 3)];
// an 8-wide platform (end, 6× middle, end): 3 objects, pays off only from the third placement
const platform = (x: number, y: number) => [dm(x, y, 0x140), dm(x + 1, y, 0x141, 6), dm(x + 7, y, 0x142)];
// a diagonal staircase of two tiles touching at a corner: one group
const stairs = (x: number, y: number) => [dm(x, y + 1, 0x150), dm(x + 1, y, 0x151)];

// ---- groups: objects touching (also at a corner) or overlapping, per layer ----
{
  const lv = { objects: [...block(0x10, 5), dm(0x20, 5, 0x160), ...stairs(0x30, 5), dm(0x13, 5, 0x170), { uid: newUid(), num: 5, ext: 0, x: 0x14, y: 5, size: 0 }], layer2Objects: null };
  const gs = dm16Groups(lv as never);
  const sizes = gs.map((g) => g.objects.length).sort((a, b) => a - b);
  // the block with the tile at its right (10 objects), the single tile, the stairs; the coin is no part
  check(JSON.stringify(sizes) === JSON.stringify([1, 2, 10]), `groups ${JSON.stringify(sizes)}`);
  check(gs.every((g) => g.layer === 1), 'layer 1');
}

const rom = new Rom(await editorImage());
installPrefabPatch(rom);
const emu = new LevelEmulator(rom);
emu.skipMask = () => gfxSkipMask(rom); // as the editor: graphics data isn't among the bytes read
emu.boot();
const load = () => emu;

const H1 = 0x105, H2 = 0x106;
check(suggestPrefabs(rom, { levels: usedLevels(rom), emu: load }).length === 0, 'the clean game: no suggestions');
{
  const lv = loadLevel(rom, H1);
  lv.objects.push(...block(0x20, 5), ...block(0x30, 8), ...platform(0x40, 10), ...stairs(0x50, 4), ...stairs(0x58, 4), dm(0x60, 4, 0x180, 2, 2));
  saveLevel(rom, lv);
}
{
  const lv = loadLevel(rom, H2);
  lv.objects.push(...blockSplit(0x24, 6), ...platform(0x40, 10));
  saveLevel(rom, lv);
}

const steps = prefabSuggestions(rom, { levels: usedLevels(rom), emu: load });
let yields = 0, r = steps.next();
while (!r.done) { yields++; r = steps.next(); }
const list = r.value;
check(yields > 1, `computed in steps (${yields})`);
const blk = list.find((s) => s.prefab.w === 3 && s.prefab.h === 3);
check(!!blk && blk.count === 3, `the block: 3 places (${blk?.count})`);
check(!!blk && JSON.stringify(blk.levels) === JSON.stringify([H1, H2]), `the block: levels ${blk?.levels}`);
check(!!blk && blk.saved === 3 * (9 * 6 - 4) - prefabCost(blk.prefab).once, `the block saves ${blk?.saved}`);
// the platform twice does not pay off (only from the third placement); the stairs neither; a tile once is none
check(!list.some((s) => s.prefab.w === 8), 'the platform twice: not listed');
check(!list.some((s) => s.prefab.w === 2 && s.prefab.h === 2), 'stairs and a single object: not listed');
check(list.every((s) => s.saved > 0 && s.count > 1), 'only positive savings of repeated arrangements');
{
  // the platform a third time in another level: listed, after the block (sorted by the saving)
  const lv = loadLevel(rom, 0x107);
  lv.objects.push(...platform(0x20, 10));
  saveLevel(rom, lv);
  const l2 = suggestPrefabs(rom, { levels: usedLevels(rom), emu: load });
  const pl = l2.find((s) => s.prefab.w === 8);
  check(!!pl && pl.count === 3 && pl.saved === 3 * (18 - 4) - prefabCost(pl.prefab).once, `the platform thrice: listed (${pl?.saved})`);
  check(l2.length === 2 && l2[0].prefab.w === 3 && l2[1] === pl, 'sorted by the saving');
}

// the open level as edited is taken instead of its saved data
{
  const open = loadLevel(rom, H2);
  open.objects = open.objects.filter((o) => o.ext !== DM16_EXT || o.tile! < 0x100 || o.tile! > 0x108);
  const l3 = suggestPrefabs(rom, { levels: usedLevels(rom), open, emu: load });
  check(l3.find((s) => s.prefab.w === 3)?.count === 2, 'the open level as edited');
}

// a block's tile gone from lv
const tile104 = (lv: Level) => { lv.objects = lv.objects.filter((o) => !(o.ext === DM16_EXT && o.tile === 0x104)); return lv; };

// kept between runs: only the levels that changed are taken apart again, the suggestions as a full run's
{
  class Spy extends KeptSuggestions {
    took: number[] = []; // levels whose arrangements were found
    searched: number[] = []; // levels searched for places
    loaded: number[] = []; // levels loaded (as saved) for their content
    setArrangements(...a: Parameters<KeptSuggestions['setArrangements']>) { this.took.push(a[0]); super.setArrangements(...a); }
    setPlaces(...a: Parameters<KeptSuggestions['setPlaces']>) { this.searched.push(a[0]); super.setPlaces(...a); }
    setSavedContent(...a: Parameters<KeptSuggestions['setSavedContent']>) { this.loaded.push(a[0]); super.setSavedContent(...a); }
    reset() { this.took = []; this.searched = []; this.loaded = []; }
  }
  const kept = new Spy(new RomFingerprint(rom));
  // (no emulator brings the byte pages up to date before a run: the run does it itself)
  const run = (open?: Level) => { kept.reset(); return suggestPrefabs(rom, { levels: usedLevels(rom), open, emu: load, kept }); };
  const same = (open: Level | undefined, what: string) => {
    const k = run(open);
    const full = suggestPrefabs(rom, { levels: usedLevels(rom), open, emu: load });
    check(full.length > 0 && JSON.stringify(k) === JSON.stringify(full), `${what}: the suggestions of a full run`);
  };
  const only = (levels: number[], what: string, loaded = levels) => {
    const took = [...new Set(kept.took)], searched = [...new Set(kept.searched)];
    check(JSON.stringify(took) === JSON.stringify(levels), `${what}: levels taken apart ${took.map((n) => n.toString(16))}`);
    check(searched.every((n) => levels.includes(n)), `${what}: levels searched ${searched.map((n) => n.toString(16))}`);
    check(JSON.stringify(kept.loaded) === JSON.stringify(loaded), `${what}: levels loaded ${kept.loaded.map((n) => n.toString(16))}`);
  };
  // the latest run's suggestions hold (kept at once) or not after a change
  const holds = (open: Level | undefined, want: boolean, what: string) =>
    check((kept.held(rom, { levels: usedLevels(rom), open, emu: load }) !== null) === want, `${what}: the latest suggestions ${want ? 'hold' : 'don\'t hold'}`);
  same(undefined, 'first run');
  check(kept.took.length === usedLevels(rom).length && kept.searched.length > 0, 'first run: every level taken apart');
  check(kept.loaded.length === usedLevels(rom).length, 'first run: every level loaded');
  holds(undefined, true, 'nothing changed');
  same(undefined, 'again');
  only([], 'nothing changed');
  // a bound far below the places of a cold run: all are kept for the next run
  {
    const small = new Spy(new RomFingerprint(rom), 2);
    suggestPrefabs(rom, { levels: usedLevels(rom), emu: load, kept: small });
    const cold = small.searched.length;
    small.reset();
    suggestPrefabs(rom, { levels: usedLevels(rom), emu: load, kept: small });
    check(cold > 2 && !small.searched.length, `a cold run of ${cold} place searches with a bound of 2: none searched again`);
    // a level edited (searched again first): the unchanged levels' places are still kept
    const edited = H2;
    const open = loadLevel(rom, edited);
    tile104(open);
    small.reset();
    suggestPrefabs(rom, { levels: usedLevels(rom), open, emu: load, kept: small });
    check(small.searched.length > 0 && small.searched.every((n) => n === edited), `a level edited with a bound of 2: only it searched again (${[...new Set(small.searched)].map((n) => n.toString(16))})`);
  }
  // the open level as edited: a block's tile gone (as a place it is gone)
  const open = loadLevel(rom, H2);
  holds(open, true, 'a level opened'); // (without edits: its content is its saved one's)
  tile104(open);
  same(open, 'open level edited');
  only([H2], 'open level edited', []);
  check(kept.searched.includes(H2), 'open level edited: searched again');
  // a sprite of the open level moved: its objects are the same
  holds(open, true, 'a sprite moved');
  open.sprites[0].x++;
  holds(open, true, 'a sprite moved');
  open.sprites[0].x--;
  // in a mode without layer 1 objects the open level as edited still has them: an edit of them counts
  {
    const boss = structuredClone(open);
    boss.header.mode = Array.from({ length: 0x20 }, (_, m) => m).find((m) => !hasObjects(m))!;
    same(boss, 'a mode without layer 1 objects');
    const b2 = structuredClone(boss);
    b2.objects = b2.objects.filter((o) => !(o.ext === DM16_EXT && o.tile === 0x105));
    holds(b2, false, 'a mode without layer 1 objects, an object deleted');
    same(b2, 'a mode without layer 1 objects, an object deleted');
    only([H2], 'a mode without layer 1 objects, an object deleted', []);
  }
  same(open, 'open level edited again');
  // a ROM edit no level's data and no search read: a pixel in a graphics file
  const f = readGfx(rom, 0x14);
  f.pix[3] ^= 1;
  writeGfx(rom, f);
  holds(open, true, 'a graphics file edited');
  same(undefined, 'a graphics file edited');
  only([], 'a graphics file edited');
  // another level saved: only it is taken apart again, and loaded (no other level's data is read)
  const other = usedLevels(rom).find((n) => n !== H1 && n !== H2 && n !== 0x107)!;
  const lv = loadLevel(rom, other);
  lv.objects.push(dm(0x70, 4, 0x190));
  saveLevel(rom, lv);
  holds(undefined, false, 'another level saved');
  {
    const reads = new RomReads(rom.data.length);
    rom.reads = reads;
    run();
    rom.reads = null;
    only([other], 'another level saved');
    const h1 = snesToPc(rom.r24(L1_PTRS + H1 * 3)), size = loadLevel(rom, H1).l1Size;
    check(!reads.touches([[h1 + 5, h1 + size]]), 'another level saved: an unchanged level\'s data not read');
  }
  same(undefined, 'another level saved');
  // a place with another object between its objects: its search loads the level, and the bytes the load read count
  // (a color of the shared palettes: the test's emulator leaves out only graphics data)
  const h = loadLevel(rom, H1), b = block(0x70, 12);
  h.objects.push(...b.slice(0, 4), { uid: newUid(), num: 5, ext: 0, x: 0x78, y: 2, size: 0 }, ...b.slice(4));
  saveLevel(rom, h);
  same(undefined, 'a place with an object between');
  only([H1], 'a place with an object between');
  const c = snesToPc(SHARED_PALETTES) + 2;
  holds(undefined, true, 'before a color edited');
  rom.writeAt(c, Uint8Array.of(rom.data[c] ^ 0x1f));
  holds(undefined, false, 'a color edited');
  same(undefined, 'a color edited');
  check(!kept.took.length && JSON.stringify([...new Set(kept.searched)]) === JSON.stringify([H1]), `a color edited: only the search that loaded again (${kept.searched.map((n) => n.toString(16))})`);
  // a level with places saved: the suggestion follows
  const h1 = loadLevel(rom, H1);
  h1.objects.push(...platform(0x70, 12));
  saveLevel(rom, h1);
  same(undefined, 'a level with places saved');
  only([H1], 'a level with places saved');
}

// the latest run's suggestions back at once: an undo back to its state, another level opened without edits, an edit
// of an open level that isn't among the levels (#212)
{
  const kept = new KeptSuggestions(new RomFingerprint(rom));
  const src = (open?: Level) => ({ levels: usedLevels(rom), open, emu: load, kept });
  const held = (open: Level | undefined) => kept.held(rom, src(open));
  const list = suggestPrefabs(rom, src(loadLevel(rom, H2))); // (H2 open: not loaded as saved)
  check(list.length > 0 && held(loadLevel(rom, H2)) === list, 'nothing changed: the run\'s list');
  // the open level edited, the edit undone
  check(held(tile104(loadLevel(rom, H2))) === null, 'the open level edited: not held');
  check(held(loadLevel(rom, H2)) === list, 'the edit undone: held');
  // a byte of a level's data changed and changed back (a ROM edit undone)
  const d = snesToPc(rom.r24(L1_PTRS + H1 * 3)) + 5, was = rom.data[d];
  rom.writeAt(d, Uint8Array.of(was ^ 1));
  check(held(loadLevel(rom, H2)) === null, 'a level\'s data changed: not held');
  rom.writeAt(d, Uint8Array.of(was));
  check(held(loadLevel(rom, H2)) === list, 'a ROM edit undone: held');
  // another level opened without edits: the one open before taken as saved (loaded for it), the same content
  check(held(loadLevel(rom, H1)) === list, 'another level opened: held');
  check(held(loadLevel(rom, H1)) === list && held(undefined) === list, 'another level opened: held again, also with none open');
  // with edits of the level open before unsaved: its saved content isn't what the run took
  suggestPrefabs(rom, src(tile104(loadLevel(rom, H2))));
  check(held(tile104(loadLevel(rom, H2))) !== null, 'H2 edited: held');
  check(held(loadLevel(rom, H1)) === null, 'another level opened, the edits of the one before unsaved: not held');
  // the level open before saved after the switch: its load's bytes count
  const l2 = suggestPrefabs(rom, src(loadLevel(rom, H2)));
  check(held(loadLevel(rom, H1)) === l2, 'another level opened: held (2)');
  const h2 = loadLevel(rom, H2);
  h2.objects.push(dm(0x70, 4, 0x191));
  saveLevel(rom, h2);
  check(held(loadLevel(rom, H1)) === null, 'the level open before saved after the switch: not held');
  // a suggestion saved as prefab with its places replaced: not held; undone (the ROM as before): the run's whole list
  // with it again (its places are back)
  {
    const l4 = suggestPrefabs(rom, src(undefined)), s = l4.find((q) => q.prefab.w === 3)!, before = rom.data.slice();
    writePrefab(rom, 7, { ...s.prefab, name: 'Block' });
    applyPrefabPlaces(rom, 7, s.places);
    check(held(undefined) === null, 'a suggestion saved: not held');
    rom.writeAt(0, before);
    check(held(undefined) === l4 && l4.includes(s), 'the save undone: held, with the saved suggestion');
  }
  // an edit of an open level that isn't among the levels: held
  const l3 = suggestPrefabs(rom, src(loadLevel(rom, H1)));
  const unused = Array.from({ length: 0x200 }, (_, n) => n).find((n) => !usedLevels(rom).includes(n))!;
  const u = loadLevel(rom, unused);
  check(held(u) === l3, 'a level not among them opened: held');
  u.objects.push(...block(0x20, 5));
  check(held(u) === l3, 'a level not among them edited: held');
}

// replaced by the prefab: the suggestion is gone
{
  const before = suggestPrefabs(rom, { levels: usedLevels(rom), emu: load });
  const b = before.find((s) => s.prefab.w === 3)!;
  writePrefab(rom, 7, { ...b.prefab, name: 'Block' });
  applyPrefabPlaces(rom, 7, b.places);
  const after = suggestPrefabs(rom, { levels: usedLevels(rom), emu: load });
  check(!after.some((s) => s.key === b.key), 'saved as prefab: gone');
  check(after.some((s) => s.prefab.w === 8), 'the others stay');
}

console.log(fail ? `${fail} failures` : 'prefab suggestions ok');
if (fail) process.exitCode = 1;
