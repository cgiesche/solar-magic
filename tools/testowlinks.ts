// Overworld links (owlinks.ts): star/pipe and exit path tiles leading elsewhere, the exit path table with 0x80
// entries (owteleport.ts) and the Koopa Kids' teleports. Checked on the model – the clean game's entries read as
// links (both ways where an entry leads back) and written again unchanged – and by emulation: Mario walking through
// each of the game's exit paths arrives where he does in the clean game, through a link made in the editor (also in
// the table's last entry) where it leads, warps by a star link made, and is put at a Koopa Kid's place set.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { readExitPaths, readExitPath, writeExitPath, readTeleports, writeTeleport, EXIT_PATHS, FIND_HOOK, GAME_EXIT_TABLES, GAME_EXITS, type OwTile, type OwPos } from '../src/core/owteleport.ts';
import { readLinks, makeLink, removeLink, setBothWays, exitEntry, pathSide, koopaTeleport, setKoopaTeleport, opposite, SIDES, type LinkEnd, type OwLink } from '../src/core/owlinks.ts';
import { l1Index, overworldDataRanges } from '../src/core/overworld.ts';
import { readSecondaryEntrance, writeSecondaryEntrance, newOverworldExit } from '../src/core/level.ts';
import { GM, RAM, get16, set16 } from '../src/core/ram.ts';
import { PAD } from '../src/core/blockprobe.ts';
import { editorImage, cleanImage, romDiff } from './fixture.ts';

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
  const exits = links.filter((l) => l.kind === 'exit'), warps = links.filter((l) => l.kind === 'warp');
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
  console.log(`     star/pipe: ${warps.map(show).join(' ')}`);
  check(warps.reduce((n, l) => n + l.entries.length, 0) === 27, 'the 27 star/pipe entries in links');
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
  check(inside(0x048e49) && inside(rom.r24(rom.r24(0x049a36) + 0x11)) && inside(rom.r24(rom.r24(0x049a36) + 0x48)), 'the tables are overworld data');
}

// ---- the model: making, changing and removing links ----
{
  const r = new Rom(rom.data.slice());
  const a: LinkEnd = { submap: 0, x: 0x0c, y: 0x09 }, b: LinkEnd = { submap: 2, x: 5, y: 6 };
  const l = makeLink(r, 'warp', a, b, true);
  const t = readTeleports(r);
  check(l.entries.length === 2 && l.entries.every((i) => i >= 27) && JSON.stringify(t[l.entries[1]].to) === JSON.stringify({ submap: 0, x: 0x0c, y: 0x09 }), `a star link both ways: entries ${l.entries}`);
  const found = readLinks(r).find((k) => k.kind === 'warp' && k.a.x === 0x0c && k.a.y === 9);
  check(!!found && found.both && JSON.stringify(found.entries) === JSON.stringify(l.entries), 'read back as one link both ways');
  const one = setBothWays(r, l, false);
  check(!one.both && !readTeleports(r)[l.entries[1]].from && !readTeleports(r)[l.entries[1]].to, 'made one-way: the entry back unused');
  // a star entry an entrance teleports to stays as that location when the link is removed
  const idx = l.entries[0];
  const s = readSecondaryEntrance(r, 0x40);
  writeSecondaryEntrance(r, 0x40, { ...s, destLevel: 0x105, overworld: { ...newOverworldExit(), teleport: 1, location: idx } });
  removeLink(r, one);
  check(!readTeleports(r)[idx].from && JSON.stringify(readTeleports(r)[idx].to) === JSON.stringify({ submap: 2, x: 5, y: 6 }), 'removed: an entry an entrance teleports to stays a location');
  const again = makeLink(r, 'warp', { submap: 0, x: 0x0d, y: 0x09 }, b, false);
  check(again.entries[0] !== idx, `a new link doesn't take the location (${again.entries[0]})`);
  // exit paths: from a tile whose path goes on, to a tile's other side
  const ea: LinkEnd = { submap: 0, x: 2, y: 0x14, side: 0 }, eb: LinkEnd = { submap: 2, x: 5, y: 0x14, side: 0 };
  const e = exitEntry(ea, eb);
  check(e.from.x === 0x28 && e.from.y === 0x140 && e.to.x === 0x58 && e.to.y === 0x150 && e.tile.x === 5 && e.tile.y === 0x14, `an exit path entry: ${JSON.stringify(e)}`);
  check(pathSide({ submap: 0, x: 2, y: 0x14 }, (x, y) => x === 2 && y === 0x13) === 0 && pathSide({ submap: 1, x: 0, y: 5 }, () => false) === 3 && opposite(2) === 3,
    'the side of a path: toward a path tile, else away from the map\'s edge');
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
  const there = exitRoutine(r2, exitEntry(yi.a, vdEnd).from), home = exitRoutine(r2, exitEntry(vdEnd, yi.a).from);
  check(leads(there, vdEnd) && leads(home, yi.a), `a link made both ways (entries ${made.entries}): there ${res(there)}, back ${res(home)}`);
}
{
  // a star made to warp: Mario on its tile, the patch's search finds the entry, the overworld loads at its target
  const r = new Rom(rom.data.slice());
  const from: OwTile = { submap: 0, x: 0x0c, y: 0x09 }, to: OwTile = { submap: 4, x: 7, y: 8 };
  const l = makeLink(r, 'warp', from, to, false);
  const e = new LevelEmulator(r);
  e.startGame(0);
  const w = e.snes.wram;
  w[RAM.playerIndex] = 0; w[RAM.currentPlayer] = 0; w[RAM.submap] = 0;
  w[RAM.owPlayerTileX] = from.x; w[RAM.owPlayerTileY] = from.y; w[RAM.owPlayerTileX + 1] = w[RAM.owPlayerTileY + 1] = 0;
  e.call(r.r24(FIND_HOOK + 1), 0);
  const found = w[RAM.owWarpIndex];
  w[RAM.owWarp] = 1; w[RAM.gameMode] = GM.overworldLoad;
  for (let f = 0; f < 400 && w[RAM.gameMode] !== GM.overworld; f++) e.snes.runFrame();
  check(found === l.entries[0] && w[RAM.submap] === 4 && get16(w, RAM.owPlayerTileX) === 7 && get16(w, RAM.owPlayerTileY) === 8,
    `a star link warps: entry ${found}, Mario on submap ${w[RAM.submap]} at ${get16(w, RAM.owPlayerTileX)},${get16(w, RAM.owPlayerTileY)}`);
}
{
  // losing to Koopa Kid 1 (a level of Yoshi's Island left by dying while it is there): Mario at its place
  const r = new Rom(rom.data.slice());
  setKoopaTeleport(r, 1, { x: 0x0c, y: 0x09 });
  const e = new LevelEmulator(r), s = e.snes, w = s.wram;
  e.startGame(0x29);
  e.loadInGame(0x105, 0x29);
  for (let f = 0; f < 600 && (w[RAM.gameMode] !== GM.level || w[RAM.marioAnim] !== 0); f++) s.runFrame();
  w[RAM.koopaKid] = 1; w[RAM.koopaKidSlot] = 0x80; w[RAM.marioAnim] = 9;
  let left = false;
  for (let f = 0; f < 1500 && !(left && w[RAM.gameMode] === GM.overworld); f++) { s.runFrame(); if (w[RAM.gameMode] !== GM.level) left = true; }
  check(w[RAM.gameMode] === GM.overworld && get16(w, RAM.owPlayerX) === 0xc8 && get16(w, RAM.owPlayerY) === 0x98,
    `lost to Koopa Kid 1: Mario at ${hx(get16(w, RAM.owPlayerX))},${hx(get16(w, RAM.owPlayerY))} (C8,98: tile 0C,09)`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
