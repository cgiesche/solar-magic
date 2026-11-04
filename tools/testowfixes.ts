// Ways out of overworld refusals (core/owfixes.ts, #349), on the test ROM: each refusal provoked, the fix applied with
// the refused edit in one ROM edit, the edit then accepted; undo restores both. A tile nothing becomes when revealed:
// the change added to the reveal list in a pair that never applies; the star/pipe and exit path tables full: the
// entries nothing uses removed (a later entry has their tile, a location no entrance uses); no free layer 1 tile: a
// copy of tile 000 on a map taken.
// node tools/testowfixes.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { readL1, writeL1, l1Index, revealAt, revealedTile, readRevealList, owTileWords, setOwTileWords, OW_L1_TILES } from '../src/core/overworld.ts';
import { addReveal } from '../src/core/oweventtiles.ts';
import { makeLink, readLinks } from '../src/core/owlinks.ts';
import { readTeleports, writeTeleport, writeExitPath, EXIT_PATHS } from '../src/core/owteleport.ts';
import { emptyL1Tiles, freeL1Tiles } from '../src/core/owl1sheet.ts';
import { refusalOf } from '../src/core/owrefusal.ts';
import {
  revealPairFor, addRevealPair, unusedLinkEntries, freeLinkEntries, tileCopiesOf000, takeTileCopy, newL1Tile,
} from '../src/core/owfixes.ts';
import { linkTableFix } from '../src/ui/owfixes.ts';
import type { App } from '../src/ui/app.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const kind = (f: () => void): string => { try { f(); return ''; } catch (e) { return refusalOf(e)?.kind ?? String(e); } };

const image = await editorImage();
const kinds = pathKinds(new Rom(image.slice()));

// ---- a tile nothing becomes when revealed: the change added to the reveal list ----
{
  const rom = new Rom(image.slice()), s = new RomEditSession(rom), before = rom.data.slice();
  const e = 0x12, i = l1Index(0, 4, 4), t = readL1(rom)[i], into = 0x01;
  check(kind(() => addReveal(new Rom(image.slice()), e, i, into)) === 'revealNoSource', `tile ${t.toString(16)} → 01: refused (no pair gives 01)`);
  const k = revealPairFor(rom, t, into);
  check(k >= 0, `a pair that never applies: ${k + 1}`);
  let said = '';
  s.edit('fix and reveal', () => { said = addRevealPair(rom, t, into); addReveal(rom, e, i, into); }, { key: null });
  check(revealAt(rom, e) === i && readL1(rom)[i] === t && revealedTile(rom, t) === into, `added: event 12 reveals the cell, its tile ${t.toString(16)} becoming 01 ("${said}")`);
  check(readRevealList(rom).filter((p, n) => n !== k).every((p, n) => { const o = readRevealList(new Rom(image.slice())).filter((_, m) => m !== k)[n]; return p.from === o.from && p.to === o.to; }), 'the other pairs kept');
  check(s.history.undoStack.length === 1, 'one ROM edit');
  s.undo();
  check(same(rom.data, before), 'undone: as before');
  check(revealPairFor(rom, 0x6e, 0x01) < 0, 'a tile that becomes another already (6E → 66): no fix');
  check(revealPairFor(rom, t, 0x101) < 0, 'a tile of the other page: no fix');
}

// ---- the link tables full: the entries nothing uses removed ----
{
  const rom = new Rom(image.slice()), base = new Rom(image.slice());
  check(!unusedLinkEntries(base, 'star').length && !unusedLinkEntries(base, 'exit').length, 'the game\'s links: every entry used');
  // the free entries filled: each star/pipe entry from the same tile (the game finds the last), each exit path from
  // the same position; one location no entrance teleports to
  const stars = readTeleports(rom), here = { submap: 1, x: 2, y: 2 };
  const free = stars.flatMap((t, k) => (!t.from && !t.to ? [k] : []));
  writeTeleport(rom, free[0], { from: null, to: { submap: 1, x: 4, y: 4 } });
  for (const k of free.slice(1)) writeTeleport(rom, k, { from: here, to: { submap: 1, x: 3, y: 3 } });
  const exits = readLinks(rom).filter((l) => l.kind === 'exit').flatMap((l) => l.entries);
  const freeExits = Array.from({ length: EXIT_PATHS }, (_, k) => k).filter((k) => !exits.includes(k));
  for (const k of freeExits) writeExitPath(rom, k, { from: { submap: 1, x: 40, y: 24 }, to: { submap: 2, x: 8, y: 8 }, tile: { x: 0, y: 0 } });
  const s = new RomEditSession(rom), before = rom.data.slice();
  const a = { submap: 0, x: 5, y: 5 }, b = { submap: 1, x: 6, y: 6 };
  check(kind(() => makeLink(new Rom(rom.data.slice()), 'star', a, b, false)) === 'teleportsFull', 'the star/pipe table full: refused');
  check(kind(() => makeLink(new Rom(rom.data.slice()), 'exit', { ...a, side: 0 }, { ...b, side: 1 }, false)) === 'exitPathsFull', 'the exit path table full: refused');
  const us = unusedLinkEntries(rom, 'star'), ue = unusedLinkEntries(rom, 'exit');
  check(same(us, free.slice(0, -1)) && same(ue, freeExits.slice(0, -1)), `unused: ${us.length} star/pipe entries (the location and those before the last from the same tile), ${ue.length} exit path entries`);
  let said = '';
  s.edit('fix and link', () => { said = freeLinkEntries(rom, 'star', us); makeLink(rom, 'star', a, b, false); }, { key: null });
  check(readLinks(rom).some((l) => l.kind === 'star' && l.a.x === 5 && l.b.x === 6) && readLinks(rom).some((l) => l.kind === 'star' && l.a.x === 2) && s.history.undoStack.length === 1,
    `freed and linked in one ROM edit, the tile's link kept ("${said}")`);
  s.edit('fix and exit path', () => { said = freeLinkEntries(rom, 'exit', ue); makeLink(rom, 'exit', { ...a, side: 0 }, { ...b, side: 1 }, false); }, { key: null });
  check(readLinks(rom).some((l) => l.kind === 'exit' && l.a.x === 5 && l.b.x === 6) && s.history.undoStack.length === 2, `exit paths freed and linked ("${said}")`);
  s.undo(); s.undo();
  check(same(rom.data, before), 'undone: as before');
  // the refusal's fix button (ui/owrefusal.ts): offered where entries can be freed, its label and hover saying so
  const app = { rom } as unknown as App;
  const fix = linkTableFix(app, { kind: 'teleportsFull', max: 0x100 });
  check(fix?.label === `Free ${us.length} unused links` && /nothing uses/.test(fix.preview), `the fix offered: "${fix?.label}"`);
  check(!linkTableFix({ rom: base } as unknown as App, { kind: 'teleportsFull', max: 0x100 }) && !linkTableFix(app, { kind: 'linkToItself' }), 'none where nothing can be freed or for another refusal');
}

// ---- no free layer 1 tile: a copy of tile 000 on a map taken ----
{
  const rom = new Rom(image.slice()), zero = owTileWords(rom, 0), one = owTileWords(rom, 1);
  const empty = emptyL1Tiles(rom);
  // every empty tile given a look (tile 01's), then one of them made a copy of 000 again and put on the main map
  for (let t = 0; t < OW_L1_TILES; t++) if (empty[t]) setOwTileWords(rom, t, one);
  const c = empty.findIndex((e, t) => e && kinds[t] === kinds[0]), at = l1Index(0, 4, 4);
  setOwTileWords(rom, c, zero);
  const m = readL1(rom); m[at] = c; writeL1(rom, m);
  check(!freeL1Tiles(emptyL1Tiles(rom), kinds).some(Boolean) && kind(() => newL1Tile(rom, kinds)) === 'noFreeL1Tile', 'no free layer 1 tile: a new one refused');
  check(tileCopiesOf000(rom, kinds).includes(c), `tile ${c.toString(16)}, a copy of 000 on the map, offered`);
  const s = new RomEditSession(rom), before = rom.data.slice();
  let said = '', got = -1;
  s.edit('fix and new tile', () => { said = takeTileCopy(rom, c); got = newL1Tile(rom, kinds); }, { key: null });
  check(got === c && readL1(rom)[at] === 0, `taken: tile ${c.toString(16)} free, its place holds 000 ("${said}")`);
  check(s.history.undoStack.length === 1, 'one ROM edit');
  s.undo();
  check(same(rom.data, before), 'undone: as before');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
