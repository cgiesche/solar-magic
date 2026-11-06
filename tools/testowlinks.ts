// Overworld links (owlinks.ts): star/pipe and exit path tiles leading elsewhere, the exit path table with 0x80
// entries (owteleport.ts) and the Koopa Kids' teleports. Checked on the model – the clean game's entries read as
// links (both ways where an entry leads back) and written again unchanged – and by emulation: Mario walking through
// each of the game's exit paths arrives where he does in the clean game, through a link made in the editor (also in
// the table's last entry) where it leads, stars by a star link made, and is put at a Koopa Kid's place set.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { readExitPaths, readExitPath, writeExitPath, readTeleports, writeTeleport, tileText, EXIT_PATHS, EXIT_HOOK, FIND_HOOK, GAME_EXIT_TABLES, GAME_EXITS, sameTile as same, type OwTile, type OwPos } from '../src/core/owteleport.ts';
import { readLinks, makeLink, removeLink, setBothWays, moveLocation, exitEntry, pathSide, koopaTeleport, setKoopaTeleport, opposite, sidesMatch, exitOut, exitOutText, SIDES, KOOPA_X, type LinkEnd, type OwLink } from '../src/core/owlinks.ts';
import { l1Index, overworldDataRanges, readL1, gameL1, OW_EVENTS, OverworldEmulator, OverworldLoads } from '../src/core/overworld.ts';
import { submapsShowing, pathSubmap, endChoice, endChoiceText, linksEndingAt, clickedLinks, misplacedEnds, moveEnd } from '../src/core/owlinkends.ts';
import { submapViews, submapOf, submapShown, inView } from '../src/core/owevents.ts';
import { readSecondaryEntrance, writeSecondaryEntrance, newOverworldExit } from '../src/core/level.ts';
import { GM, RAM, PAD, MARIO_DYING, get16, set16 } from '../src/core/ram.ts';
import { editorImage, cleanImage, romDiff, pathShapes, pathKinds } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();
const end = (e: LinkEnd) => `${e.submap}:${hx(e.x)},${hx(e.y)}${e.side === undefined ? '' : '↑↓←→'[e.side]}`;
const show = (l: OwLink) => `${end(l.a)}${l.both ? '↔' : '→'}${end(l.b)}`;

const rom = new Rom(await editorImage());
const clean = new Rom(cleanImage());
const links = readLinks(rom);

// ---- the clean game's links ----
{
  const exits = links.filter((l) => l.kind === 'exit'), stars = links.filter((l) => l.kind === 'star');
  check(readExitPaths(rom).filter(Boolean).length === GAME_EXITS && readExitPaths(rom).length === EXIT_PATHS, `${GAME_EXITS} exit paths of the game, ${EXIT_PATHS} entries`);
  const game = Array.from({ length: GAME_EXITS }, (_, i) => {
    const b = (t: number, n: number) => clean.bytes(GAME_EXIT_TABLES[t] + i * n, n).join();
    const e = readExitPath(rom, i)!;
    return b(0, 5) === [e.from.y & 0xff, e.from.y >> 8, e.from.x & 0xff, e.from.x >> 8, e.from.submap].join()
      && b(1, 5) === [e.to.y & 0xff, e.to.y >> 8, e.to.x & 0xff, e.to.x >> 8, e.to.submap].join() && b(2, 2) === [e.tile.y, e.tile.x].join();
  });
  check(game.every(Boolean), 'the game\'s exit path entries copied');
  check(exits.length === 7 && exits.every((l) => l.both && l.a.side !== undefined && l.b.side !== undefined), `7 exit paths both ways: ${exits.map(show).join(' ')}`);
  const yi = exits.find((l) => l.a.submap === 0 && l.a.x === 2 && l.a.y === 0x14);
  check(!!yi && yi.a.side === 0 && yi.b.submap === 1 && yi.b.x === 4 && yi.b.y === 0 && yi.b.side === 1, `main map 02,14 (path up) ↔ Yoshi's Island 04,00 (path down): ${yi && show(yi)}`);
  console.log(`     star/pipe: ${stars.map(show).join(' ')}`);
  check(stars.reduce((n, l) => n + l.entries.length, 0) === 27, 'the 27 star/pipe entries in links');
  // every link made again as it is: no byte changes
  const r = new Rom(rom.data.slice());
  for (const l of links) makeLink(r, l.kind, l.a, l.b, l.both);
  check(romDiff(rom.data, r.data) === 0, `every link made again as it is: ${romDiff(rom.data, r.data)} bytes changed`);
  const kp = [0, 1, 2].map((k) => koopaTeleport(rom, k));
  check(JSON.stringify(kp) === JSON.stringify([{ x: 0x12, y: 0x1c }, null, { x: 0x18, y: 0x1d }]), `Koopa Kid teleports: ${JSON.stringify(kp)}`);
  const kr = new Rom(rom.data.slice());
  kp.forEach((t, k) => setKoopaTeleport(kr, k, t));
  check(romDiff(rom.data, kr.data) === 0, 'Koopa Kid teleports written again unchanged');
  const ranges = overworldDataRanges(rom), inside = (snes: number) => ranges.some(([a, b]) => snesToPc(snes) >= a && snesToPc(snes) < b);
  check(inside(KOOPA_X) && inside(rom.r24(rom.r24(EXIT_HOOK + 1) + 0x11)) && inside(rom.r24(rom.r24(EXIT_HOOK + 1) + 0x48)), 'the tables are overworld data');
}

// ---- the model: making, changing and removing links ----
{
  const r = new Rom(rom.data.slice());
  const a: LinkEnd = { submap: 0, x: 0x0c, y: 0x09 }, b: LinkEnd = { submap: 2, x: 5, y: 6 };
  const l = makeLink(r, 'star', a, b, true);
  const t = readTeleports(r);
  check(l.entries.length === 2 && l.entries.every((i) => i >= 27) && JSON.stringify(t[l.entries[1]].to) === JSON.stringify({ submap: 0, x: 0x0c, y: 0x09 }), `a star link both ways: entries ${l.entries}`);
  const found = readLinks(r).find((k) => k.kind === 'star' && k.a.x === 0x0c && k.a.y === 9);
  check(!!found && found.both && JSON.stringify(found.entries) === JSON.stringify(l.entries), 'read back as one link both ways');
  const one = setBothWays(r, l, false);
  check(!one.both && !readTeleports(r)[l.entries[1]].from && !readTeleports(r)[l.entries[1]].to, 'made one-way: the entry back unused');
  // a star entry an entrance teleports to stays as that location when the link is removed
  const idx = l.entries[0];
  const s = readSecondaryEntrance(r, 0x40);
  writeSecondaryEntrance(r, 0x40, { ...s, destLevel: 0x105, overworld: { ...newOverworldExit(), teleport: 1, location: idx } });
  removeLink(r, one);
  check(!readTeleports(r)[idx].from && JSON.stringify(readTeleports(r)[idx].to) === JSON.stringify({ submap: 2, x: 5, y: 6 }), 'removed: an entry an entrance teleports to stays a location');
  const again = makeLink(r, 'star', { submap: 0, x: 0x0d, y: 0x09 }, b, false);
  check(again.entries[0] !== idx, `a new link doesn't take the location (${again.entries[0]})`);
  // the star of a location's entry led elsewhere, a location moved: the other keeps leading where it did
  const r2 = new Rom(r.data.slice()), star = makeLink(r2, 'star', a, b, false);
  writeSecondaryEntrance(r2, 0x40, { ...s, destLevel: 0x105, overworld: { ...newOverworldExit(), teleport: 1, location: star.entries[0] } });
  const moved = makeLink(r2, 'star', a, { submap: 3, x: 1, y: 2 }, false), t2 = readTeleports(r2);
  check(moved.entries[0] !== star.entries[0] && !t2[star.entries[0]].from && JSON.stringify(t2[star.entries[0]].to) === JSON.stringify(b),
    `a star led elsewhere takes another entry (${moved.entries[0]}), its old one stays the location`);
  const r3 = new Rom(r.data.slice()), shared = makeLink(r3, 'star', a, b, false);
  moveLocation(r3, shared.entries[0], { submap: 3, x: 1, y: 2 });
  const l3 = readLinks(r3).find((k) => k.kind === 'star' && k.a.x === a.x && k.a.y === a.y);
  check(!!l3 && JSON.stringify(l3.b) === JSON.stringify(b) && JSON.stringify(readTeleports(r3)[shared.entries[0]]) === JSON.stringify({ from: null, to: { submap: 3, x: 1, y: 2 } }),
    `a location moved: the star of its entry still leads to ${l3 && JSON.stringify(l3.b)}`);
  // exit paths: from a tile whose path goes on, to a tile's other side
  const ea: LinkEnd = { submap: 0, x: 2, y: 0x14, side: 0 }, eb: LinkEnd = { submap: 2, x: 5, y: 0x14, side: 0 };
  const e = exitEntry(ea, eb);
  check(e.from.x === 0x28 && e.from.y === 0x140 && e.to.x === 0x58 && e.to.y === 0x150 && e.tile.x === 5 && e.tile.y === 0x14, `an exit path entry: ${JSON.stringify(e)}`);
  check(pathSide({ submap: 0, x: 2, y: 0x14 }, (x, y) => x === 2 && y === 0x13) === 0 && pathSide({ submap: 1, x: 0, y: 5 }, () => false) === 3 && opposite(2) === 3,
    'the side of a path: toward a path tile, else away from the map\'s edge');
}

// ---- the target's side follows the source's (#401) ----
{
  const shapes = pathShapes(rom), tileAt = (t: OwTile) => readL1(rom)[l1Index(t.submap ? 1 : 0, t.x, t.y)];
  // made with any target side: the opposite one, in the entries and read back; linkCheck takes the same
  const r = new Rom(rom.data.slice()), a: LinkEnd = { submap: 0, x: 4, y: 4, side: 2 };
  const made = [0, 1, 2, 3].map((side) => { const k = new Rom(r.data.slice()); return { k, l: makeLink(k, 'exit', a, { submap: 3, x: 6, y: 7, side }, true) }; });
  check(made.every(({ l }) => l.b.side === 3 && sidesMatch(l)) && made.every(({ k }) => romDiff(made[0].k.data, k.data) === 0),
    `an exit path made with any target side: the source's opposite (${made.map(({ l }) => show(l)).join(' ')}), the same entries`);
  const back = readLinks(made[0].k).find((l) => l.kind === 'exit' && same(l.a, a));
  check(!!back && back.both && back.b.side === 3 && back.a.side === 2, `read back: ${back && show(back)}`);
  // the game's links all have it so
  check(links.filter((l) => l.kind === 'exit').every(sidesMatch), 'the game\'s exit paths: every target side opposite to its source\'s');
  // which way Mario comes out: from the source exit tile's learned vector
  const yi = yiLink(), foi = links.find((l) => l.kind === 'exit' && tileAt(l.a) === 0x42)!;
  const says = (from: LinkEnd, to: LinkEnd, tile = tileAt(from)) => exitOutText(exitOut(from, to, tile, shapes), tileText(to));
  const want: [string, string][] = [
    [says(yi.a, yi.b), 'Mario comes out above Yoshi\'s Island 04,00, walking down'],
    [says(yi.b, yi.a), 'Mario comes out below Main map 02,14, walking up'],
    [says(foi.a, foi.b), `Mario comes out ${foi.a.side === 2 ? 'left of' : 'right of'} ${tileText(foi.b)}, walking ${foi.a.side === 2 ? 'right' : 'left'}`],
    // the ladder's tile replaced by 42 (horizontal): turned by 90°
    [says(yi.a, yi.b, 0x42), 'Mario comes out above Yoshi\'s Island 04,00, walking right'],
    [exitOutText(exitOut(yi.a, yi.b, 0x40, null), tileText(yi.b)), 'Mario comes out above Yoshi\'s Island 04,00'],
  ];
  for (const [got, w] of want) check(got === w, `${got} (${w})`);
  // a ROM's pair of other sides (Lunar Magic's) is read as it is, not rewritten (the World check warns: testowreach)
  const m = new Rom(rom.data.slice()), e = exitEntry(yi.a, { ...yi.b, side: 3 });
  writeExitPath(m, yi.entries[0], e);
  const before = m.data.slice(), mis = readLinks(m).find((l) => l.kind === 'exit' && same(l.a, yi.a));
  check(!!mis && mis.b.side === 3 && !sidesMatch(mis) && romDiff(before, m.data) === 0, `a mismatched pair read unchanged: ${mis && show(mis)}`);
  check(says(mis!.a, mis!.b) === 'Mario comes out left of Yoshi\'s Island 04,00, walking down', `and said so: ${says(mis!.a, mis!.b)}`);
}

// ---- by emulation ----
// the game's exit path routine ($049A24, which the patch hooks) run with Mario at `at` on its submap: where it puts him
const EXIT_ROUTINE = 0x049a24;
function exitRoutine(r: Rom, at: OwPos) {
  const emu = new LevelEmulator(r);
  emu.startGame(0);
  const s = emu.snes, cpu = s.cpu, w = s.wram, RET = 0x8000;
  w[RAM.currentPlayer] = 0; w[RAM.playerIndex] = 0; w[RAM.submap] = at.submap;
  set16(w, RAM.owPlayerX, at.x); set16(w, RAM.owPlayerY, at.y); w[RAM.owSubmap] = 0xee;
  Object.assign(cpu, { e: false, p: 0x30, d: 0, dbr: 0x04, pbr: EXIT_ROUTINE >> 16, pc: EXIT_ROUTINE & 0xffff, s: 0x1fd, waiting: false, stopped: false });
  w[0x1fe] = (RET - 1) & 0xff; w[0x1ff] = (RET - 1) >> 8;
  for (let n = 0; n < 20000 && cpu.pc !== RET; n++) cpu.step();
  return { submap: w[RAM.owSubmap], x: get16(w, RAM.owPlayerX), y: get16(w, RAM.owPlayerY), tx: get16(w, RAM.owPlayerTileX), ty: get16(w, RAM.owPlayerTileY) };
}
const res = (p: ReturnType<typeof exitRoutine>) => `${p.submap}:${hx(p.x)},${hx(p.y)} tile ${hx(p.tx)},${hx(p.ty)}`;
const leads = (p: ReturnType<typeof exitRoutine>, b: LinkEnd) => { const e = exitEntry({ ...b, side: 0 }, b).to; return p.submap === b.submap && p.x === e.x && p.y === e.y && p.tx === b.x && p.ty === b.y; };
// Mario standing next to tile `at` on the side its path goes on, walking onto it, until he stands again: where he
// came out on another submap and where he stands
function walk(r: Rom, at: LinkEnd) {
  const emu = new LevelEmulator(r), s = emu.snes, w = s.wram;
  const nx = at.x + SIDES[at.side!][0], ny = at.y + SIDES[at.side!][1], i = l1Index(at.submap ? 1 : 0, nx, ny);
  emu.startGameAt(i);
  w[RAM.owTranslevels + i] = 1; w[RAM.levelFlags + 1] = 0x0f; w[RAM.submap] = w[RAM.submap + 1] = at.submap;
  const pad = [PAD.down, PAD.up, PAD.right, PAD.left][at.side!]; // toward the tile
  let walked = false, out: OwPos | null = null;
  for (let f = 0; f < 900; f++) {
    s.joy1 = f < 4 ? pad : 0;
    s.runFrame();
    if (!out && w[RAM.submap] !== at.submap) out = { submap: w[RAM.submap], x: get16(w, RAM.owPlayerX), y: get16(w, RAM.owPlayerY) };
    if (w[RAM.owProcess] !== 3) walked = true;
    else if (walked && f > 30) break;
  }
  return { out, stands: { submap: w[RAM.submap], x: get16(w, RAM.owPlayerX), y: get16(w, RAM.owPlayerY) } };
}
const pos = (p: OwPos | null) => (p ? `${p.submap}:${hx(p.x)},${hx(p.y)}` : 'none');
{
  const differ: string[] = [];
  for (const l of links.filter((k) => k.kind === 'exit')) {
    for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) {
      const from = exitEntry(a, b).from, got = exitRoutine(rom, from), want = exitRoutine(clean, from);
      if (res(got) !== res(want) || !leads(got, b)) differ.push(`${end(a)}: ${res(got)} (${res(want)})`);
    }
  }
  check(!differ.length, `the game's 14 exit paths: Mario put where the clean game puts him, at the link's target ${differ.join('; ')}`);
  const none = exitRoutine(rom, { submap: 0, x: 0x48, y: 0x48 });
  check(none.submap === 0 && none.x === 0x48 && none.y === 0x48, `a position no exit path is taken from: Mario stays (${res(none)})`);
  const a = walk(rom, yiLink().a), c = walk(clean, yiLink().a);
  check(pos(a.out) === pos(c.out) && pos(a.stands) === pos(c.stands) && a.out?.submap === 1, `walked onto main map 02,14: out at ${pos(a.out)}, stands at ${pos(a.stands)} (clean game: ${pos(c.out)}, ${pos(c.stands)})`);
}
function yiLink(): OwLink { return links.find((l) => l.kind === 'exit' && l.a.submap === 0 && l.a.x === 2)!; }
{
  // main map 02,14 led to Vanilla Dome 05,14 instead of Yoshi's Island, in the table's last entry
  const r = new Rom(rom.data.slice());
  const yi = yiLink();
  const vd = links.find((l) => l.kind === 'exit' && (l.a.submap === 2 || l.b.submap === 2))!;
  const vdEnd = vd.a.submap === 2 ? vd.a : vd.b;
  removeLink(r, yi);
  writeExitPath(r, EXIT_PATHS - 1, exitEntry(yi.a, vdEnd));
  const got = walk(r, yi.a);
  check(pos(got.out) === pos(exitEntry(yi.a, vdEnd).to) && got.stands.submap === 2, `an exit path in entry 7F: out at ${pos(got.out)}, stands at ${pos(got.stands)}`);
  const back = readLinks(r).find((l) => l.kind === 'exit' && l.entries.includes(EXIT_PATHS - 1));
  check(!!back && !back.both && back.b.x === vdEnd.x && back.b.y === vdEnd.y && back.b.side === vdEnd.side, `read back: ${back && show(back)}`);
  // made by the editor, both ways
  const r2 = new Rom(rom.data.slice());
  removeLink(r2, yi);
  const made = makeLink(r2, 'exit', yi.a, vdEnd, true);
  // (the target's side derived: opposite to the source's, not Vanilla Dome 05,14's path above)
  const there = exitRoutine(r2, exitEntry(yi.a, made.b).from), home = exitRoutine(r2, exitEntry(made.b, yi.a).from);
  check(made.b.side === opposite(yi.a.side!) && leads(there, made.b) && leads(home, yi.a), `a link made both ways (entries ${made.entries}, ${show(made)}): there ${res(there)}, back ${res(home)}`);
}
// Mario on star tile `from`: the entry the patch's search finds, where the overworld loads
function warp(r: Rom, from: OwTile) {
  const e = new LevelEmulator(r);
  e.startGame(0);
  const w = e.snes.wram;
  w[RAM.playerIndex] = 0; w[RAM.currentPlayer] = 0; w[RAM.submap] = from.submap;
  w[RAM.owPlayerTileX] = from.x; w[RAM.owPlayerTileY] = from.y; w[RAM.owPlayerTileX + 1] = w[RAM.owPlayerTileY + 1] = 0;
  e.call(r.r24(FIND_HOOK + 1), 0);
  const found = w[RAM.owWarpIndex];
  w[RAM.owWarp] = 1; w[RAM.gameMode] = GM.overworldLoad;
  for (let f = 0; f < 400 && w[RAM.gameMode] !== GM.overworld; f++) e.snes.runFrame();
  return { found, submap: w[RAM.submap], x: get16(w, RAM.owPlayerTileX), y: get16(w, RAM.owPlayerTileY) };
}
{
  // a star made to warp: Mario on its tile, the patch's search finds the entry, the overworld loads at its target
  const r = new Rom(rom.data.slice());
  const from: OwTile = { submap: 0, x: 0x0c, y: 0x09 }, to: OwTile = { submap: 4, x: 7, y: 8 };
  const l = makeLink(r, 'star', from, to, false), got = warp(r, from);
  check(got.found === l.entries[0] && got.submap === 4 && got.x === 7 && got.y === 8,
    `a star link stars: entry ${got.found}, Mario on submap ${got.submap} at ${got.x},${got.y}`);
}
{
  // #403: a link end set in an overlap of two submaps' views takes the submap shown – Vanilla Dome 05,14 lies in Forest
  // of Illusion's view too, nearer its center (submapOf alone: Forest of Illusion)
  const views = submapViews(new OverworldLoads(new OverworldEmulator(new Rom(rom.data.slice())), 6)), vd = l1Index(1, 5, 0x14);
  const at = (shown: number) => submapShown(views, vd, shown);
  check(submapOf(views, vd) === 3 && inView(views[2], vd) && inView(views[3], vd), `Vanilla Dome 05,14 in the views of Vanilla Dome and Forest of Illusion, nearest the latter's center`);
  check(at(2) === 2 && at(3) === 3, `with Vanilla Dome shown on submap ${at(2)}, with Forest of Illusion shown on ${at(3)}`);
  const yiTop = l1Index(1, 4, 0);
  check(submapShown(views, yiTop, 2) === 1 && submapShown(views, vd, 0) === 3 && submapShown(views, vd, 1) === 3, `a tile outside the shown submap's view (or the main map shown): submapOf`);
  check(inView(views[1], l1Index(1, 0x1f, 5)) && !inView(views[1], l1Index(1, 0x1e, 5)), `Yoshi's Island's view wraps around the region's left edge (x 1F shows, 1E doesn't)`);
  // (the links panel warns of an end its submap's view doesn't show: none of the game's)
  const off = links.flatMap((l) => [l.a, l.b]).filter((t) => t.submap > 0 && !inView(views[t.submap], l1Index(1, t.x, t.y)));
  check(!off.length && !inView(views[3], l1Index(1, 5, 0x0e)), `every end of the game's links shows in its submap's view (not: ${off.map((t) => tileText(t)).join(' ')}); Forest of Illusion 05,0E would not`);
  // the game's exit path to Vanilla Dome 05,14 is the link at the tile clicked there with Vanilla Dome shown
  const t: OwTile = { submap: at(2), x: 5, y: 0x14 };
  check(links.some((l) => l.kind === 'exit' && (same(l.b, t) || same(l.a, t))), `the game's exit path found at ${tileText(t)} (${links.filter((l) => same(l.b, t)).map(show).join(' ')})`);
  // a star link made there leads Mario to Vanilla Dome (emulated)
  const r = new Rom(rom.data.slice()), from: OwTile = { submap: 0, x: 0x0c, y: 0x09 };
  const l = makeLink(r, 'star', from, t, false), got = warp(r, from);
  check(tileText(l.b) === 'Vanilla Dome 05,14' && got.found === l.entries[0] && got.submap === 2 && got.x === 5 && got.y === 0x14,
    `a star link to ${tileText(l.b)}: Mario on submap ${got.submap} at ${hx(got.x)},${hx(got.y)}`);
}
{
  // #404: a link end dropped in an overlap of views asks which submap, the one whose paths the tile is on preselected;
  // a click there finds a link ending on any of them; an end on the other submap is found (the World check's warning)
  // and moved where its paths are
  const loads = new OverworldLoads(new OverworldEmulator(new Rom(rom.data.slice())), 6), views = submapViews(loads);
  const kinds = pathKinds(rom), l1 = gameL1(loads.get(0, OW_EVENTS)).slice();
  const vd = l1Index(1, 5, 0x14), foi = l1Index(1, 8, 0x15), yiTop = l1Index(1, 4, 0);
  const choice = (i: number, shown: number) => endChoice(l1, kinds, views, i, shown).join();
  check(submapsShowing(views, vd).join() === '2,3' && pathSubmap(l1, kinds, views, vd) === 2, 'Vanilla Dome 05,14: in the views of Vanilla Dome and Forest of Illusion, on Vanilla Dome\'s paths');
  check(choice(vd, 1) === '2,3' && choice(vd, 3) === '2,3' && choice(vd, 0) === '2,3', `dropped there with Yoshi's Island, Forest of Illusion or the main map shown: Vanilla Dome first, then Forest of Illusion (${choice(vd, 1)})`);
  check(choice(foi, 2) === '3,2', `Forest of Illusion 08,15 (its exit to Vanilla Dome's 05,14): Forest of Illusion first (${choice(foi, 2)})`);
  // a tile in one view only, the main map: one submap, no menu; a tile in an overlap no paths decide: the shown one
  const one = l1Index(1, 4, 4), blank = l1Index(1, 1, 0x13);
  check(choice(one, 2) === '1' && choice(l1Index(0, 0x0c, 9), 2) === '0', `a tile in Yoshi's Island's view only: ${choice(one, 2)}; on the main map: ${choice(l1Index(0, 0x0c, 9), 2)}`);
  check(kinds[l1[blank]] === 'none' && submapsShowing(views, blank).join() === '2,3' && choice(blank, 3) === '3,2' && choice(blank, 1) === `${submapOf(views, blank)},${5 - submapOf(views, blank)}`,
    `a tile without paths in the overlap: the shown submap (${choice(blank, 3)}), else the nearest view's (${choice(blank, 1)})`);
  check(endChoiceText([2, 3], vd) === '→ Vanilla Dome 05,14 · in an overlap, you\'ll be asked' && endChoiceText([1], yiTop) === '→ Yoshi\'s Island 04,00',
    `the status bar while dragging: "${endChoiceText([2, 3], vd)}"`);
  check(!misplacedEnds(links, l1, kinds, views).length, 'the clean game: no link end on the other submap of an overlap');
  // a star stored as Forest of Illusion 05,14 (as submapOf wrote it before #403)
  const r = new Rom(rom.data.slice()), from: OwTile = { submap: 0, x: 0x0c, y: 0x09 };
  const l = makeLink(r, 'star', from, { submap: 3, x: 5, y: 0x14 }, false), rl = readLinks(r);
  const found = (shown: number) => linksEndingAt(rl, vd, [shown, ...submapsShowing(views, vd).filter((s) => s !== shown)]).map((f) => `${show(f.link)} ${f.end}`);
  check(found(2).length === 2 && found(2)[0].includes('2:5,14') && found(2)[1] === '0:C,9→3:5,14 b' && found(3)[0] === '0:C,9→3:5,14 b' && found(3).length === 2,
    `a click on 05,14 finds the game's exit path and the star on Forest of Illusion: with Vanilla Dome shown ${found(2).join(', ')}; with Forest of Illusion ${found(3).join(', ')}`);
  const clicked = (order: number[]) => clickedLinks(rl, vd, order).map(show).join(' ');
  check(clicked([2, 3]) === show(rl.find((k) => k.kind === 'exit' && k.b.submap === 2 && k.b.x === 5)!) && clicked([3, 2]) === '0:C,9→3:5,14' && clicked([1, 2, 3]).split(' ').length === 2,
    `a click selects the link on the submap acted on (${clicked([2, 3])}; ${clicked([3, 2])}), links on two others only: both to choose from (${clicked([1, 2, 3])})`);
  const m = misplacedEnds(rl, l1, kinds, views);
  check(m.length === 1 && m[0].end === 'b' && m[0].to === 2 && m[0].link.entries.join() === l.entries.join(), `found as on the other submap: ${m.map((x) => `${show(x.link)} ${x.end} → ${x.to}`)}`);
  if (m.length) {
    const moved = moveEnd(r, m[0]), got = warp(r, from);
    check(tileText(moved.b) === 'Vanilla Dome 05,14' && got.found === moved.entries[0] && got.submap === 2 && got.x === 5 && got.y === 0x14 && !misplacedEnds(readLinks(r), l1, kinds, views).length,
      `moved to ${tileText(moved.b)}: Mario on submap ${got.submap} at ${hx(got.x)},${hx(got.y)} (emulated)`);
  }
}
{
  // #374: of two entries with a star's tile the game takes the last – the link read there, led elsewhere and moved there
  const r = new Rom(rom.data.slice());
  const star = links.find((l) => l.kind === 'star' && l.both)!, game = readTeleports(r)[star.entries[0]];
  const LATE = 0x40, EARLY = 0x30, decoy: OwTile = { submap: 5, x: 3, y: 3 }, to: OwTile = { submap: 4, x: 7, y: 8 };
  writeTeleport(r, star.entries[0], { from: null, to: null });
  writeTeleport(r, LATE, game); // the game's entry, later in the table
  writeTeleport(r, EARLY, { from: game.from, to: decoy }); // an earlier one with its tile, never found
  const before = warp(r, star.a);
  check(before.found === LATE && before.submap === star.b.submap && before.x === star.b.x && before.y === star.b.y,
    `${show(star)} with an earlier entry of its tile: the game takes the last (${hx(before.found)})`);
  const read = readLinks(r).filter((l) => l.kind === 'star' && (same(l.a, star.a) || same(l.b, star.a)));
  check(read.length === 1 && read[0].both && read[0].entries.includes(LATE) && !read[0].entries.includes(EARLY) && same(read[0].a, star.b),
    `read: the link of the last entry only (${read.map(show).join(' ')}, entries ${read[0]?.entries.map(hx)})`);
  const led = makeLink(new Rom(r.data.slice()), 'star', star.a, to, false);
  check(led.entries[0] === LATE, `led elsewhere: entry ${hx(led.entries[0])} changed (the last)`);
  // its target moved, as the editor's drag does: the link removed (the earlier entry with it, else the tile would lead
  // to the decoy now), made again
  removeLink(r, read[0]);
  check(!readTeleports(r).some((t) => t.from && (same(t.from, star.a) || same(t.from, star.b))), 'removed: no entry of its tiles left, the earlier one too');
  const moved = makeLink(r, 'star', star.a, to, true), got = warp(r, star.a);
  check(got.found === moved.entries[0] && got.submap === to.submap && got.x === to.x && got.y === to.y,
    `moved: the game takes entry ${hx(got.found)} (made ${moved.entries.map(hx)}), Mario on submap ${got.submap} at ${got.x},${got.y}`);
  // the last entry a location too, moved: the star keeps leading where it did, not to the earlier entry's decoy
  const r3 = new Rom(r.data.slice());
  writeTeleport(r3, moved.entries[0], { from: null, to: null });
  writeTeleport(r3, LATE, { from: star.a, to });
  writeTeleport(r3, EARLY, { from: star.a, to: decoy });
  writeSecondaryEntrance(r3, 0x40, { ...readSecondaryEntrance(r3, 0x40), destLevel: 0x105, overworld: { ...newOverworldExit(), teleport: 1, location: LATE } });
  moveLocation(r3, LATE, { submap: 3, x: 1, y: 2 });
  const loc = warp(r3, star.a), t3 = readTeleports(r3);
  check(loc.submap === to.submap && loc.x === to.x && loc.y === to.y && !t3[LATE].from && same(t3[LATE].to!, { submap: 3, x: 1, y: 2 }) && !t3[EARLY].from,
    `a location moved from the star's last entry: the game takes entry ${hx(loc.found)}, Mario on submap ${loc.submap} at ${loc.x},${loc.y}`);
  // an exit path: the last entry of a position changes too
  const r2 = new Rom(rom.data.slice()), yi = yiLink(), from = exitEntry(yi.a, yi.b).from;
  const k = readExitPaths(r2).findIndex((x) => !!x && x.from.submap === from.submap && x.from.x === from.x && x.from.y === from.y);
  writeExitPath(r2, EXIT_PATHS - 1, readExitPath(r2, k));
  const ex = makeLink(r2, 'exit', yi.a, { submap: 2, x: 5, y: 0x14, side: 0 }, false);
  check(ex.entries[0] === EXIT_PATHS - 1 && JSON.stringify(readExitPath(r2, k)) === JSON.stringify(readExitPath(rom, k)),
    `an exit path led elsewhere: entry ${hx(ex.entries[0])} changed (the last), ${hx(k)} not`);
}
{
  // losing to Koopa Kid 1 (a level of Yoshi's Island left by dying while it is there): Mario at its place
  const r = new Rom(rom.data.slice());
  setKoopaTeleport(r, 1, { x: 0x0c, y: 0x09 });
  const p = PlaySession.start(new LevelEmulator(r), 0x105, { until: 'settled', game: { translevel: 0x29 } }), w = p.wram;
  w[RAM.koopaKid] = 1; w[RAM.koopaKidSlot] = 0x80; w[RAM.marioAnim] = MARIO_DYING;
  check(p.follow() === 'overworld' && get16(w, RAM.owPlayerX) === 0xc8 && get16(w, RAM.owPlayerY) === 0x98,
    `lost to Koopa Kid 1: Mario at ${hx(get16(w, RAM.owPlayerX))},${hx(get16(w, RAM.owPlayerY))} (C8,98: tile 0C,09)`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
