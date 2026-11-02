// Overworld import (owimport.ts, #91): the overworld of another ROM the editor made written into this one. A ROM with
// every part of its overworld changed (maps with layer 2 moved to free space, translevels, settings, messages, events,
// reveals, destroys, links, start, sprites, options, music, submap graphics files, palettes and animations) is imported
// into another: every part reads the same there, its levels keep their own data, the overworld loads there as in the
// other ROM (emulated: VRAM, CGRAM and the layer 1 map), what it lacks is warned. Importing a ROM's own overworld
// changes nothing.
import { Rom } from '../src/core/rom.ts';
import {
  readL1, writeL1, readL2, writeL2, readTranslevels, writeTranslevels, owTileWords, setOwTileWords, OW_L1_TILES, l1Index,
  EXIT_DIRS, MAX_TRANSLEVEL, initialFlags, setInitialFlags, baseEvent, setBaseEvent, revealEventCount, revealAt,
  setRevealAt, readRevealList, writeRevealList, readDestroyList, setDestroyEvent, setExitDirection, l2Pointers,
  OverworldEmulator, gameL1, MAP_NAMES,
} from '../src/core/overworld.ts';
import { readEvents, writeEvents } from '../src/core/owevents.ts';
import { readTeleports, writeTeleport, readExitPaths, writeExitPath } from '../src/core/owteleport.ts';
import { koopaTeleport, setKoopaTeleport } from '../src/core/owlinks.ts';
import { readStart, writeStart, readOwSprites, writeOwSprite, koopaKidPos, setKoopaKidPos } from '../src/core/owsprites.ts';
import { writeCustomSprites } from '../src/core/owcustom.ts';
import { OW_OPTIONS, owOptionValue, setOwOption, revealSpeed, setRevealSpeed, submapLightning, setSubmapLightning } from '../src/core/owoptions.ts';
import { levelNameTiles, setLevelNameTiles, encodeName, NAME_TRANSLEVELS } from '../src/core/levelnames.ts';
import { readMessage, writeMessages, textToLine, TRANSLEVELS } from '../src/core/messages.ts';
import { submapPalette, setSubmapColor, SUBMAPS } from '../src/core/submapgfx.ts';
import { levelGfx, setLevelGfx, submapGfxEntry } from '../src/core/patches.ts';
import { levelLayer3 } from '../src/core/layer3gfx.ts';
import { createGfx } from '../src/core/gfxfiles.ts';
import { readSubmapList, writeSubmapList, readOwGlobalList, submapAnimSettings, setSubmapAnimSettings, writeAltFile, emptyList, listBytes, SUBMAP_LISTS, type ExList } from '../src/core/exanim.ts';
import { submapMusic, setSubmapMusic } from '../src/core/music.ts';
import { importOverworld } from '../src/core/owimport.ts';
import { same } from '../src/core/globalgfx.ts';
import { KOOPAS } from '../src/core/owlinks.ts';
import { KOOPA_KIDS } from '../src/core/owsprites.ts';
import { allOrNothing } from '../src/core/romedit.ts';
import { editorImage, romDiff } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

// everything of the overworld the import copies, as its modules read it
function overworld(r: Rom): Record<string, string> {
  const j = (v: unknown) => JSON.stringify(v, (_, x) => (x instanceof Map ? [...x] : ArrayBuffer.isView(x) ? [...(x as Uint8Array)] : x));
  const per = <T>(n: number, f: (k: number) => T) => j(Array.from({ length: n }, (_, k) => f(k)));
  return {
    'layer 1': j(readL1(r)), 'layer 2': j(readL2(r)), 'translevels': j(readTranslevels(r)),
    'layer 1 Map16': per(OW_L1_TILES, (t) => owTileWords(r, t)),
    'exit directions': j(r.bytes(EXIT_DIRS, MAX_TRANSLEVEL + 1)),
    'initial flags': per(MAX_TRANSLEVEL + 1, (tl) => initialFlags(r, tl)), 'base events': per(MAX_TRANSLEVEL + 1, (tl) => baseEvent(r, tl)),
    'names': per(NAME_TRANSLEVELS, (tl) => levelNameTiles(r, tl)), 'messages': per(TRANSLEVELS, (tl) => [readMessage(r, tl, 1), readMessage(r, tl, 2)]),
    'events': j(readEvents(r)), 'reveals': per(revealEventCount(r), (e) => revealAt(r, e)), 'reveal list': j(readRevealList(r)), 'destroys': j(readDestroyList(r)),
    'star/pipe': j(readTeleports(r)), 'exit paths': j(readExitPaths(r)), 'Koopa teleports': per(KOOPAS, (k) => koopaTeleport(r, k)),
    'start': per(2, (p) => readStart(r, p)), 'sprites': j(readOwSprites(r)), 'Koopa Kids': per(KOOPA_KIDS, (k) => koopaKidPos(r, k)),
    'options': j(OW_OPTIONS.map((o) => owOptionValue(r, o.id))), 'reveal speed': j(revealSpeed(r)), 'lightning': per(SUBMAPS, (m) => submapLightning(r, m)),
    'music': per(SUBMAPS, (m) => submapMusic(r, m)), 'graphics files': per(SUBMAPS, (m) => [levelGfx(r, submapGfxEntry(m)), levelLayer3(r, submapGfxEntry(m))]),
    'palettes': per(SUBMAPS * 2, (k) => submapPalette(r, k % SUBMAPS, k >= SUBMAPS)),
    'animations': j([...Array.from({ length: SUBMAP_LISTS }, (_, m) => readSubmapList(r, m)), readOwGlobalList(r)].map((l) => l && listBytes(l))),
    'animation settings': per(SUBMAP_LISTS, (m) => submapAnimSettings(r, m)),
  };
}

const base = await editorImage();

// ---- a ROM whose overworld is changed everywhere ----
const src = new Rom(base.slice());
{
  const l1 = readL1(src);
  l1[l1Index(0, 5, 5)] = 0x66;
  writeL1(src, l1);
  const l2 = readL2(src), oldL2 = l2Pointers(src).tiles;
  let seed = 1;
  for (let k = 0; k < l2.length; k++) { seed = (seed * 1103515245 + 12345) >>> 0; l2[k] = (seed >> 16) & 0x3fff; } // doesn't compress: moved to free space
  writeL2(src, l2);
  check(l2Pointers(src).tiles !== oldL2, 'the other ROM\'s layer 2 moved to free space');
  setOwTileWords(src, 0x10, [0x1234, 0x2345, 0x3456, 0x0567]);
  const tls = readTranslevels(src);
  tls[l1Index(0, 5, 5)] = 0x30;
  writeTranslevels(src, tls);
  setLevelNameTiles(src, 0x30, encodeName('IMPORTED LEVEL').tiles);
  setBaseEvent(src, 0x30, 0x70);
  setExitDirection(src, 0x30, 0, ((src.r8(EXIT_DIRS + 0x30) >> 6) + 1) & 3);
  setInitialFlags(src, 0x30, 0x0f);
  writeMessages(src, [{ translevel: 0x30, msg: 1, message: [textToLine('FROM THE OTHER ROM'), ...Array.from({ length: 7 }, () => [])] }]);
  const ev = readEvents(src);
  ev.silent[0x70].push({ layer: 1, tile: 0x66, loc: l1Index(0, 6, 5) });
  ev.steps[0x70].push(...ev.steps[1]);
  writeEvents(src, ev);
  setRevealAt(src, 0x71, l1Index(0, 5, 5));
  writeRevealList(src, readRevealList(src).map((p, k) => (k === 3 ? { from: 0x66, to: 0x67 } : p)));
  setDestroyEvent(src, l1Index(0, 7, 7), 0x72);
  writeTeleport(src, 0x90, { from: { submap: 0, x: 5, y: 5 }, to: { submap: 2, x: 3, y: 4 } });
  writeExitPath(src, 0x40, { from: { submap: 0, x: 0x58, y: 0x58 }, to: { submap: 3, x: 0x38, y: 0x48 }, tile: { x: 3, y: 4 } });
  setKoopaTeleport(src, 1, { x: 9, y: 9 });
  writeStart(src, 1, { submap: 2, x: 4, y: 6 });
  writeOwSprite(src, 12, { num: 2, x: 0x80, y: 0x90 });
  setKoopaKidPos(src, 0, { x: 0x123, y: 0x45 });
  setOwOption(src, 'startScroll', !owOptionValue(src, 'startScroll'));
  setOwOption(src, 'pathFade', false);
  setRevealSpeed(src, 0x10);
  setSubmapLightning(src, 0, true);
  setSubmapMusic(src, 3, submapMusic(src, 4));
  createGfx(src, 0x100);
  const g = levelGfx(src, submapGfxEntry(1));
  g[7] = 0x100;
  setLevelGfx(src, submapGfxEntry(1), g);
  setSubmapColor(src, 2, true, 5, 0x1234);
  const alt = new Uint8Array(0x100).fill(0x5a);
  writeAltFile(src, 0, alt);
  const list: ExList = emptyList();
  list.slots.set(0, { type: 0x01, trigger: 0, framesLess1: 1, dest: 0x8000 | 0x2400, frames: [0x00, 0x20] });
  writeSubmapList(src, 1, list);
  setSubmapAnimSettings(src, 1, 0x80);
}

// ---- imported into another ROM ----
const dst = new Rom(base.slice());
setLevelGfx(dst, 0x105, [1, 2, 3, 4, 5, 6, 7, 8]); // a level's own data
writeAltFile(dst, 0, new Uint8Array(0x100).fill(0x11)); // another Anim graphic A
writeCustomSprites(dst, [[{ id: 1, x: 2, y: 3, z: 0, extra: [0] }], [], [], [], [], [], []]);
const before = new Rom(dst.data.slice());
const { warnings } = allOrNothing(dst, () => importOverworld(dst, src));
console.log(warnings.map((w) => `     warning: ${w}`).join('\n'));
const a = overworld(src), b = overworld(dst), was = overworld(before);
for (const k of Object.keys(a)) check(a[k] === b[k], `${k} as in the other ROM`);
const changed = Object.keys(a).filter((k) => a[k] === was[k]);
check(changed.length === 0, `every part was changed in the other ROM, so every part is a copy: ${changed.join(', ') || 'none the same before'}`);
check(levelGfx(dst, 0x105).join() === '1,2,3,4,5,6,7,8', 'a level\'s own data kept');
check(warnings.some((w) => /Yoshi's Island's graphics file 100: this ROM lacks it/.test(w)), 'warned: a graphics file this ROM lacks');
check(warnings.some((w) => /Anim graphic A, which is another in this ROM/.test(w)), 'warned: the animations\' Anim graphic is another here');
check(warnings.some((w) => /This ROM's 1 custom overworld sprite stays/.test(w)), 'warned: this ROM\'s custom overworld sprites stay');
check(!warnings.some((w) => /song|option|lightning/i.test(w)), 'no warning about songs, options or the lightning');

// ---- the overworld loads as in the other ROM ----
{
  // (the files the import lacks given to both: what is compared is the overworld)
  createGfx(dst, 0x100);
  writeAltFile(dst, 0, new Uint8Array(0x100).fill(0x5a));
  const es = new OverworldEmulator(src), ed = new OverworldEmulator(dst);
  for (const [m, progress] of [[0, 0], [1, 0], [2, 0x74], [3, 0]]) {
    const x = es.load(m, progress), y = ed.load(m, progress);
    check(x.ok && y.ok && same(x.vram, y.vram) && same(x.cgram, y.cgram) && same(gameL1(x), gameL1(y)), `${MAP_NAMES[m]} at progress ${progress.toString(16)}: VRAM, CGRAM and layer 1 as in the other ROM`);
  }
}

// ---- a ROM's own overworld imported into it: nothing changes ----
{
  const r = new Rom(src.data.slice());
  importOverworld(r, new Rom(src.data.slice()));
  check(romDiff(src.data, r.data) === 0, `the own overworld imported: ${romDiff(src.data, r.data)} bytes changed`);
}

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
