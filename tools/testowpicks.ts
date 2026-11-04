// The overworld editor's picks show their valid targets before the click (#348), on the editor's test ROM: per pick,
// the cells its check refuses are exactly those the edit refuses, with the same reason – "+ Reveal" (any cell but the
// main map's top left one, in an event revealing nothing yet), "+ Destroy" (a cell destroyTarget resolves), a level
// tile moved or a level placed in an event (no cell entering another level on another map; before events every
// cell), a star/pipe link's and an exit path's target, also of a link's end moved (another tile, the entries it needs
// free), a location moved, a Koopa Kid's place.
// node tools/testowpicks.ts
import { Rom } from '../src/core/rom.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { readL1, readTranslevels, l1Index, l1XY, baseEvent, OverworldEmulator, gameL1 } from '../src/core/overworld.ts';
import { layer1Without } from '../src/core/owevents.ts';
import { revealPickCheck, destroyPickCheck, addReveal, addDestroy, removeDestroy, eventDestroys } from '../src/core/oweventtiles.ts';
import { moveLevelTileCheck, placeLevelTileCheck, moveLevelTile, placeLevelTile, levelsWithoutTile, type LevelTileEvent } from '../src/core/owleveltiles.ts';
import {
  linkCheck, makeLink, removeLink, readLinks, koopaPlaceRefusal, locationMoveRefusal, moveLocation, type LinkKind, type LinkEnd, type OwLink,
} from '../src/core/owlinks.ts';
import { readTeleports, writeTeleport, readExitPaths, writeExitPath, TELEPORTS, EXIT_PATHS, type OwTile } from '../src/core/owteleport.ts';
import { levelTileTest } from '../src/core/owpaths.ts';
import { editorImage, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, k) => a + k);
const tried = (f: () => void): string | null => { try { f(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };

const image = await editorImage();
const kinds = pathKinds(new Rom(image.slice()));
const isLevel = levelTileTest(kinds);
const fresh = () => { const rom = new Rom(image.slice()); return { rom, s: new RomEditSession(rom) }; };
// the cells where the check and the edit (made, then undone) differ – in what they refuse or why
function differ(cells: number[], check: (i: number) => string | null, edit: (i: number) => string | null): number[] {
  return cells.filter((i) => check(i) !== edit(i));
}

// ---- "+ Reveal" ----
{
  const { rom, s } = fresh();
  const e = 0x12, check1 = revealPickCheck(rom, e), cells = range(0, 0x800);
  // the tile picked: 66 (a cell whose tile doesn't become it gets 6E, which does)
  const edit = (i: number) => { const why = tried(() => s.edit('reveal', () => addReveal(rom, e, i, 0x66), { key: null })); if (!why) s.undo(); return why; };
  check(!!check1(0) && cells.filter((i) => check1(i)).length === 1, 'event 12: every cell but the top left one of the main map (0 stands for none)');
  const d = differ(cells, check1, edit);
  check(!d.length, `the cells refused are those addReveal refuses, with its reason${d.length ? ` (differ: ${d.slice(0, 8).map(hx).join(' ')})` : ''}`);
  const yi2 = revealPickCheck(rom, 3);
  check(cells.every((i) => /already reveals/.test(yi2(i) ?? '')), 'an event revealing a tile already: every cell refused, saying so');
}

// ---- "+ Destroy" ----
{
  const { rom } = fresh();
  const e = 0x12, check1 = destroyPickCheck(rom, e);
  const edit = (i: number) => { const why = tried(() => addDestroy(rom, e, i)); if (!why) removeDestroy(rom, e, eventDestroys(rom, e)[0]); return why; };
  const cells = range(0, 0x800), ok = cells.filter((i) => !check1(i));
  check(ok.length >= 0x10 && ok.length < 0x100, `event 12: ${ok.length} cells can be destroyed (castles, fortresses, switch palaces and their tops)`);
  check(ok.includes(l1Index(1, 9, 1)) && ok.includes(l1Index(1, 9, 2)), 'Iggy\'s castle\'s top and its level tile among them');
  const d = differ(cells, check1, edit);
  check(!d.length, `the cells refused are those addDestroy refuses, with its reason${d.length ? ` (differ: ${d.slice(0, 8).map(hx).join(' ')})` : ''}`);
  const iggy = destroyPickCheck(rom, 6);
  check(cells.every((i) => /destroys one tile/.test(iggy(i) ?? '')), 'an event destroying a tile already: every cell refused, saying so');
}

// ---- a level tile moved or a level placed ----
{
  const { rom, s } = fresh();
  const tls = readTranslevels(rom), l1 = readL1(rom);
  const TL = 0x29, e = baseEvent(rom, TL), em = new OverworldEmulator(rom);
  const ev: LevelTileEvent = { event: e, after: gameL1(em.load(0, e + 1)).slice(), without: layer1Without(rom, e), isLevelTile: isLevel };
  const lt = range(0, 0x400).find((i) => isLevel(l1[i]) && tls[i] && ev.after[i] === l1[i] && ev.without[i] === l1[i])!;
  const cells = range(0, 0x400);
  const made = (f: () => void) => { const why = tried(() => s.edit('pick', f, { key: null })); if (!why) s.undo(); return why; };
  const move = moveLevelTileCheck(rom, lt, ev), refused = cells.filter((i) => move(i));
  check(refused.length > 5 && refused.every((i) => isLevel(ev.after[i]) && tls[i] !== tls[lt]), `in event ${hx(e)} the level tile at ${hx(lt)} can't go onto ${refused.length} cells: other levels' tiles`);
  const d1 = differ(cells, move, (i) => (i === lt ? null : made(() => moveLevelTile(rom, lt, i, ev))));
  check(!d1.length, `moved: the cells refused are those moveLevelTile refuses${d1.length ? ` (differ: ${d1.slice(0, 8).map(hx).join(' ')})` : ''}`);
  const free = levelsWithoutTile(tls)[0], place = placeLevelTileCheck(rom, 0x56, free, ev);
  const d2 = differ(cells, place, (i) => made(() => placeLevelTile(rom, i, 0x56, free, ev)));
  check(cells.some((i) => place(i)) && !d2.length, `placed: the cells refused are those placeLevelTile refuses${d2.length ? ` (differ: ${d2.slice(0, 8).map(hx).join(' ')})` : ''}`);
  const before = moveLevelTileCheck(rom, lt, null), beforeP = placeLevelTileCheck(rom, 0x56, free, null);
  check(cells.every((i) => !before(i) && !beforeP(i)), 'before events: every cell');
}

// ---- link targets ----
{
  const { rom, s } = fresh();
  const tile = (i: number): OwTile => ({ submap: i >= 0x400 ? 1 : 0, ...l1XY(i) });
  const cells = range(0, 0x800);
  const made = (f: () => void) => { const why = tried(() => s.edit('link', f, { key: null })); if (!why) s.undo(); return why; };
  const targets = (kind: LinkKind, a: LinkEnd, both: boolean, what: string) => {
    const c = linkCheck(rom, kind, both), refused = cells.filter((i) => c(a, tile(i)));
    const d = differ(cells, (i) => c(a, tile(i)), (i) => made(() => makeLink(rom, kind, a, tile(i), both)));
    check(!d.length, `${what}: the tiles refused (${refused.length}) are those makeLink refuses${d.length ? ` (differ: ${d.slice(0, 8).map(hx).join(' ')})` : ''}`);
    return refused;
  };
  // a link's end moved (the drag: removed, made anew)
  const moved = (l: OwLink, target: boolean, what: string) => {
    const c = linkCheck(rom, l.kind, l.both, l), to = (i: number) => (target ? [l.a, tile(i)] : [tile(i), l.b]) as [LinkEnd, LinkEnd];
    const d = differ(cells, (i) => c(...to(i)), (i) => made(() => { removeLink(rom, l); makeLink(rom, l.kind, ...to(i), l.both); }));
    check(!d.length, `${what}: the tiles refused are those the move refuses${d.length ? ` (differ: ${d.slice(0, 8).map(hx).join(' ')})` : ''}`);
  };
  const a: OwTile = { submap: 0, x: 4, y: 4 };
  check(targets('star', a, true, 'a star both ways').length === 1, 'a star leads anywhere but to its own tile');
  const star = readLinks(rom).find((l) => l.kind === 'star')!;
  // the star/pipe table with one entry free: both ways only to a tile with an entry of its own (one reused)
  const all = readTeleports(rom), kept = new Set(all.flatMap((t, i) => (t.from || t.to ? [i] : [])));
  for (let i = 0, n = 0; i < TELEPORTS; i++) if (!kept.has(i) && n++ > 0) writeTeleport(rom, i, { from: null, to: { submap: 6, x: 1, y: 1 } });
  const owned = new Set(readTeleports(rom).flatMap((t) => (t.from && t.from.submap === 0 ? [l1Index(0, t.from.x, t.from.y)] : [])));
  const r = targets('star', a, true, 'one star/pipe entry free, both ways');
  check(r.length > 0x700 && range(0, 0x400).filter((i) => owned.has(i)).every((i) => !r.includes(i)), 'one star/pipe entry free: both ways only to a star or pipe (its entry reused)');
  targets('star', a, false, 'one star/pipe entry free, one-way');
  moved(star, true, 'one star/pipe entry free, a star\'s target moved');
  moved(star, false, 'one star/pipe entry free, a star\'s tile moved');
  // the table full: a location taken from a star's entry can't move (the star needs another one)
  writeTeleport(rom, readTeleports(rom).findIndex((t) => !t.from && !t.to), { from: null, to: { submap: 6, x: 1, y: 1 } });
  const loc = star.entries[0], why = locationMoveRefusal(rom, loc);
  check(!!why && why === tried(() => moveLocation(rom, loc, { submap: 0, x: 1, y: 1 })), `the table full: a star's entry as a location can't be moved, as moveLocation refuses ("${why}")`);
  // the exit path table full but one entry
  for (let i = 0, n = 0; i < EXIT_PATHS; i++) if (!readExitPaths(rom)[i] && n++ > 0) writeExitPath(rom, i, { from: { submap: 6, x: 8, y: 8 }, to: { submap: 6, x: 8, y: 8 }, tile: { x: 0, y: 0 } });
  targets('exit', { ...a, side: 1 }, true, 'one exit path entry free, both ways');
  check(koopaPlaceRefusal({ submap: 1, x: 3, y: 3 }, { submap: 2, x: 3, y: 3 }) !== null && koopaPlaceRefusal({ submap: 1, x: 3, y: 3 }, { submap: 1, x: 9, y: 3 }) === null,
    'a Koopa Kid\'s place: only on the submap of its tile');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
