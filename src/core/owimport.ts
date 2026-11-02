// Overworld import (Lunar Magic's "Copy Overworld to Another ROM", issue #91): the overworld of another ROM the
// editor made (or the clean game, patched first) written into this one, as one ROM edit. No file format of its own:
// both ROMs have the editor patches, so every part is read from the other ROM through its module and written here
// through the same module – tables in free space land wherever this ROM has (or finds) room for them. Tables whose
// model keeps less than their bytes (the overworld links' pixel positions, the start positions' pixels) are copied as
// their bytes, from where the other ROM has them to where this one does.
//
// Copied: the maps (layer 1, layer 2, the layer 1 tiles' Map16), the translevel of each level tile, the events and
// their steps (silent ones too), reveals with the reveal list and destroyed level tiles, the translevels' settings
// (name, base event, exit directions, initial flags, messages), the overworld links (star/pipe and exit path tables,
// the places Koopa Kids put Mario), the start positions, the game's overworld sprites with the Koopa Kids' places, the overworld
// options and lightning, each submap's music, graphics files (slots), palettes and animations (ExAnimation lists).
// Not copied: package content – custom overworld sprites (BOWSIE's), graphics files, songs. What the import refers
// to that this ROM lacks (or has otherwise) is told as a warning; the part is still copied where it can be.

import type { Rom } from './rom.ts';
import {
  readL1, writeL1, readL2, writeL2, readTranslevels, writeTranslevels, owTileWords, setOwTileWords, OW_L1_TILES,
  exitDirections, setExitDirection, MAX_TRANSLEVEL, initialFlags, setInitialFlags, baseEvent, setBaseEvent, revealEventCount, revealAt,
  setRevealAt, readRevealList, writeRevealList, readDestroyList, writeDestroyList, overworldReplacement, MAP_NAMES,
} from './overworld.ts';
import { readEvents, writeEvents } from './owevents.ts';
import { teleportDataRanges } from './owteleport.ts';
import { koopaTeleport, setKoopaTeleport, KOOPAS } from './owlinks.ts';
import { START, hasOwSpriteSlots, readOwSprite, writeOwSprite, OW_SPRITE_SLOTS, koopaKidPos, setKoopaKidPos, KOOPA_KIDS, hasKoopaKidTable } from './owsprites.ts';
import { readCustomSprites } from './owcustom.ts';
import { syncBowsieMaxTile } from './bowsie.ts';
import { OW_OPTIONS, owOptionValue, setOwOption, revealSpeed, setRevealSpeed, submapLightning, setSubmapLightning } from './owoptions.ts';
import { levelNameTiles, setLevelNameTiles, NAME_TRANSLEVELS } from './levelnames.ts';
import { readMessage, writeMessages, TRANSLEVELS, type MessageChange } from './messages.ts';
import { setSubmapPalette, submapPalette, SUBMAPS } from './submapgfx.ts';
import { levelGfx, setLevelGfx, submapGfxEntry, GFX_NONE, gfxHex } from './patches.ts';
import { levelLayer3, setLevelLayer3 } from './layer3gfx.ts';
import { gfxBytes } from './gfxfiles.ts';
import { same } from './globalgfx.ts';
import {
  readSubmapList, writeSubmapList, readOwGlobalList, writeOwGlobalList, submapAnimSettings, setSubmapAnimSettings,
  readAltFile, usesAltFile, owExanimLayout, altFileName, SUBMAP_LISTS, type ExList,
} from './exanim.ts';
import { submapMusic, setSubmapMusic, submapSongs, hasAmk, loadMusicProject, songHex, type SongInfo } from './music.ts';

export interface OverworldImport { warnings: string[] }

const START_SIZE = 0x16; // the start positions' bytes (owsprites.ts)
// the overworld link tables' bytes in each ROM (the same tables, wherever each ROM keeps them)
const linkTables = (r: Rom) => teleportDataRanges(r).map(([a, b]) => b - a);

// why the overworld of `src` can't be imported into `dst`, null when it can
export function overworldImportProblem(dst: Rom, src: Rom): string | null {
  const rs = overworldReplacement(src), rd = overworldReplacement(dst);
  if (rs) return `The other ROM's overworld is replaced by ${rs}`;
  if (rd) return `This ROM's overworld is replaced by ${rd}`;
  if (linkTables(src).join() !== linkTables(dst).join()) return 'The overworld link tables of the two ROMs differ';
  return null;
}

// writes the overworld of `src` into `dst` (call it inside one ROM edit); throws what can't be written
export function importOverworld(dst: Rom, src: Rom): OverworldImport {
  const why = overworldImportProblem(dst, src);
  if (why) throw new Error(why);
  const warnings: string[] = [];
  const warn = (s: string) => warnings.push(s);

  // ---- the maps and the level tiles' translevels ----
  writeL1(dst, readL1(src));
  for (let t = 0; t < OW_L1_TILES; t++) setOwTileWords(dst, t, owTileWords(src, t));
  writeL2(dst, readL2(src));
  writeTranslevels(dst, readTranslevels(src));

  // ---- the translevels' settings ----
  for (let tl = 0; tl <= MAX_TRANSLEVEL; tl++) {
    exitDirections(src, tl).forEach((d, k) => setExitDirection(dst, tl, k, d));
    setInitialFlags(dst, tl, initialFlags(src, tl));
    setBaseEvent(dst, tl, baseEvent(src, tl));
  }
  for (let tl = 0; tl < NAME_TRANSLEVELS; tl++) setLevelNameTiles(dst, tl, levelNameTiles(src, tl));
  const msgs: MessageChange[] = [];
  for (let tl = 0; tl < TRANSLEVELS; tl++) for (const msg of [1, 2]) msgs.push({ translevel: tl, msg, message: readMessage(src, tl, msg) });
  writeMessages(dst, msgs);

  // ---- events: steps, reveals, destroyed level tiles ----
  writeEvents(dst, readEvents(src));
  for (let e = 0; e < revealEventCount(dst); e++) setRevealAt(dst, e, e < revealEventCount(src) ? revealAt(src, e) : 0);
  writeRevealList(dst, readRevealList(src));
  writeDestroyList(dst, readDestroyList(src));

  // ---- links, start positions, sprites ----
  const to = teleportDataRanges(dst);
  teleportDataRanges(src).forEach(([a, b], k) => dst.writeAt(to[k][0], src.data.subarray(a, b)));
  for (let k = 0; k < KOOPAS; k++) setKoopaTeleport(dst, k, koopaTeleport(src, k));
  dst.writeBytes(START, src.bytes(START, START_SIZE));
  if (hasOwSpriteSlots(src) && hasOwSpriteSlots(dst)) for (let k = 0; k < OW_SPRITE_SLOTS; k++) writeOwSprite(dst, k, readOwSprite(src, k));
  else if (hasOwSpriteSlots(src) !== hasOwSpriteSlots(dst)) warn(`The game's overworld sprites are not copied: ${hasOwSpriteSlots(dst) ? 'the other ROM' : 'this ROM'} has BOWSIE, whose loader takes their table's place`);
  const custom = (r: Rom) => readCustomSprites(r).reduce((n, l) => n + l.length, 0);
  const cs = custom(src), cd = custom(dst);
  if (cs) warn(`${cs} custom overworld sprite${cs > 1 ? 's' : ''} of the other ROM not copied: they come with a package (BOWSIE)`);
  if (cd) warn(`This ROM's ${cd} custom overworld sprite${cd > 1 ? 's stay where they are' : ' stays where it is'}`);

  // ---- options ----
  // (the path fade first: turning it on or off sets the translucency with it)
  for (const o of [...OW_OPTIONS].sort((a, b) => Number(b.id === 'pathFade') - Number(a.id === 'pathFade'))) {
    const v = owOptionValue(src, o.id), d = owOptionValue(dst, o.id);
    if (v !== null && d !== null) setOwOption(dst, o.id, v);
    else warn(`Overworld option "${o.label}" not copied: its code in ${v === null ? 'the other ROM' : 'this ROM'} was changed by a patch`);
  }
  // (BOWSIE with MaxTile only while the fade is off: re-inserted when the fade changed; throws when that fails)
  syncBowsieMaxTile(dst).forEach(warn);
  // (the Koopa Kids after it: MaxTile's code is where their table is)
  if (hasKoopaKidTable(src) && hasKoopaKidTable(dst)) for (let k = 0; k < KOOPA_KIDS; k++) setKoopaKidPos(dst, k, koopaKidPos(src, k));
  else warn(`Where the Koopa Kids jump out is not copied: ${hasKoopaKidTable(dst) ? 'the other ROM' : 'this ROM'} has BOWSIE with MaxTile, whose code takes their table's place`);
  const speed = revealSpeed(src);
  if (speed !== null && revealSpeed(dst) !== null) setRevealSpeed(dst, speed);
  const lightning = (r: Rom) => submapLightning(r, 0) !== null;
  if (lightning(src) && lightning(dst)) for (let m = 0; m < SUBMAPS; m++) setSubmapLightning(dst, m, !!submapLightning(src, m));
  else warn(`The lightning per submap not copied: its code in ${!lightning(src) && !lightning(dst) ? 'both ROMs' : lightning(src) ? 'this ROM' : 'the other ROM'} was changed by a patch`);

  // ---- per submap: music, graphics files, palettes, animations ----
  submapMusicImport(dst, src, warn);
  for (let m = 0; m < SUBMAPS; m++) {
    const e = submapGfxEntry(m), gfx = levelGfx(src, e), l3 = levelLayer3(src, e);
    setLevelGfx(dst, e, gfx);
    setLevelLayer3(dst, e, l3);
    for (const f of [...gfx, l3.lt3, ...l3.lg]) if (f !== GFX_NONE) fileCheck(dst, src, f, `${MAP_NAMES[m]}'s graphics file ${gfxHex(f)}`, warn);
    for (const special of [false, true]) setSubmapPalette(dst, m, special, submapPalette(src, m, special));
  }
  if (owExanimLayout(src) && owExanimLayout(dst)) {
    const anims = new Set<number>();
    const used = (l: ExList | null) => { if (l && [...l.slots.values()].some(usesAltFile)) anims.add(l.altFile); return l; };
    for (let m = 0; m < SUBMAP_LISTS; m++) {
      writeSubmapList(dst, m, used(readSubmapList(src, m)));
      setSubmapAnimSettings(dst, m, submapAnimSettings(src, m));
    }
    writeOwGlobalList(dst, used(readOwGlobalList(src)));
    for (const n of anims) {
      const a = readAltFile(src, n), b = readAltFile(dst, n);
      if (!a || !b || !same(a, b)) warn(`The overworld's animations take frames from ${altFileName(n)}, which ${b ? 'is another in this ROM' : 'this ROM lacks'}`);
    }
  } else warn(`The overworld's animations not copied: ${owExanimLayout(src) ? 'this ROM' : 'the other ROM'} has no ExAnimation for the overworld`);
  return { warnings: [...new Set(warnings)] };
}

// a graphics file the import refers to: warned when this ROM lacks it or has another under its number
function fileCheck(dst: Rom, src: Rom, f: number, what: string, warn: (s: string) => void): void {
  const a = gfxBytes(src, f), b = gfxBytes(dst, f);
  if (!a) return; // (the other ROM lacks it too: nothing changes)
  if (!b) warn(`${what}: this ROM lacks it`);
  else if (!same(a.data, b.data)) warn(`${what}: another file in this ROM`);
}

// each submap's song, under this ROM's number for it (the game's songs move with AddmusicK); a song this ROM lacks or
// has another under its number warned, kept as it is here
function submapMusicImport(dst: Rom, src: Rom, warn: (s: string) => void): void {
  const songs = (r: Rom): SongInfo[] => { try { return submapSongs(r, loadMusicProject(r)); } catch { return submapSongs(r); } };
  const from = songs(src), to = songs(dst);
  const sameEngine = hasAmk(src) === hasAmk(dst);
  for (let m = 0; m < SUBMAPS; m++) {
    const num = submapMusic(src, m), s = from.find((x) => x.num === num);
    // (with and without AddmusicK the game's songs are told by their name)
    const t = sameEngine ? to.find((x) => x.num === num) : s && s.kind !== 'custom' ? to.find((x) => x.kind !== 'custom' && x.name === s.name) : undefined;
    const name = s?.name ?? songHex(num);
    if (!t) warn(`${MAP_NAMES[m]}'s song ${songHex(num)} (${name}): this ROM lacks it – kept this ROM's`);
    else if (s && s.kind === 'custom' && (t.kind !== 'custom' || t.name !== s.name)) { warn(`${MAP_NAMES[m]}'s song ${songHex(num)} (${name}): this ROM has ${t.name} under its number – kept this ROM's`); continue; }
    if (t) setSubmapMusic(dst, m, t.num);
  }
}
