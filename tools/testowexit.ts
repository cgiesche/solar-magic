// Secondary entrances to the overworld (Lunar Magic 3.00's, level.ts OverworldExit; levelheight.ts) and the
// overworld's star/pipe table with 0x100 entries (owteleport.ts). Checked on the model and by emulation: a
// level left through such an entrance returns to the overworld with the action's result (nothing, the normal
// or the secret exit passed – the event of the tile Mario stood on, or another base event –, the turn ended),
// from Mario's tile or teleported to a location; other entrances and the game's star and pipe warps are as
// in the clean game.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import {
  readSecondaryEntrance, writeSecondaryEntrance, decodeSecondaryEntrance, newOverworldExit, SEC_ENT, OW_NOTHING, OW_NORMAL, OW_SECRET, OW_END_TURN,
  type OverworldExit,
} from '../src/core/level.ts';
import { ExitGraph } from '../src/core/exitgraph.ts';
import { readTeleport, readTeleports, writeTeleport, locationFor, TELEPORTS, FIND_HOOK, GAME_TABLES, GAME_ENTRIES, type OwTile } from '../src/core/owteleport.ts';
import { BASE_EVENTS } from '../src/core/overworld.ts';
import { GM, RAM, get16 } from '../src/core/ram.ts';
import { editorImage, cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16);

const rom = new Rom(await editorImage());
const clean = new Rom(cleanImage());
const N = 0x105, TL = 0x29; // Yoshi's Island 1, its translevel

// ---- the model ----
{
  // the bytes Lunar Magic 3.71 wrote for entrance 1CB of level 105 set to the overworld: the normal exit,
  // teleport to location 5, base event 12
  const e = decodeSecondaryEntrance([0x05, 0x05, 0x12, 0x39, 0x80, 0x00]);
  const o = e.overworld;
  check(e.destLevel === N && o?.action === OW_NORMAL && o.teleport === 1 && o.location === 5 && o.ownEvent === 1 && o.event === 0x12,
    `Lunar Magic's bytes: level ${hx(e.destLevel)}, ${JSON.stringify(o)}`);
  const r = new Rom(rom.data.slice());
  writeSecondaryEntrance(r, 0x40, e);
  check(SEC_ENT.map((t) => r.r8(t + 0x40)).join() === [0x05, 0x05, 0x12, 0x39, 0x80, 0x00].join(), 'written back as Lunar Magic wrote it');
  // the other entrances read and write as before
  const same = Array.from({ length: 0x200 }, (_, i) => i).every((i) => {
    const before = SEC_ENT.map((t) => r.r8(t + i)).join();
    writeSecondaryEntrance(r, i, readSecondaryEntrance(r, i));
    return SEC_ENT.map((t) => r.r8(t + i)).join() === before;
  });
  check(same && Array.from({ length: 0x200 }, (_, i) => i).every((i) => i === 0x40 || !readSecondaryEntrance(r, i).overworld), 'the game\'s entrances: none to the overworld, unchanged by reading and writing');
  // not into its level: neither one of its entrances nor an exit's target
  writeSecondaryEntrance(r, 0x41, { ...readSecondaryEntrance(r, 0x1cb), overworld: newOverworldExit() });
  const g = new ExitGraph(r, { number: N, exits: [{ uid: 1, screen: 7, dest: 0x41, secondary: true, flags: 0x04 | 0x02 }] });
  const ref = g.usersOfEntrance(0x41)[0];
  check(!g.entrancesOf(N).includes(0x41) && ref?.overworld === true && ref.to === -1 && !g.exitsInto(N).some((x) => x.entrance === 0x41),
    `an exit through it leads to the overworld (${JSON.stringify(ref)}), not into level ${hx(N)}`);
}

// ---- the teleport table ----
const gameEntry = (i: number) => {
  return GAME_TABLES.map((a) => clean.r16(a + i * 2));
};
{
  const all = readTeleports(rom);
  const first = Array.from({ length: GAME_ENTRIES }, (_, i) => i).every((i) => {
    const [fx, fy, tx, ty] = gameEntry(i), e = all[i];
    return e.from && e.to && ((e.from.submap << 8) | e.from.x) === fx && e.from.y === fy && ((e.to.submap << 9) | (e.to.x * 16 + 8)) === tx && e.to.y * 16 + 8 === ty;
  });
  check(all.length === TELEPORTS && first && all.slice(27).every((e) => !e.from && !e.to), 'the game\'s 27 star/pipe entries, then 229 unused');
  const r = new Rom(rom.data.slice());
  const star = readTeleport(r, 3).to!;
  check(locationFor(r, star) === 3, `a star's destination: its index (3, ${JSON.stringify(star)})`);
  const tile: OwTile = { submap: 0, x: 0x0c, y: 0x09 };
  const a = locationFor(r, tile), b = locationFor(r, tile);
  check(a === 27 && b === 27 && JSON.stringify(readTeleport(r, 27)) === JSON.stringify({ from: null, to: tile }), `a new location: entry ${a}, then found again`);
  check(locationFor(r, { submap: 1, x: 1, y: 1 }, new Set([28])) === 29, 'entries kept in use are left out');
}

// ---- by emulation ----
const owState = (w: Uint8Array) => ({
  player: w[RAM.playerIndex], submap: w[RAM.submap + w[RAM.playerIndex]],
  x: get16(w, RAM.owPlayerTileX + w[RAM.currentPlayer]), y: get16(w, RAM.owPlayerTileY + w[RAM.currentPlayer]),
  events: Array.from(w.subarray(RAM.owEvents, RAM.owEvents + 15)),
});
type OwState = ReturnType<typeof owState>;
const event = (s: OwState, n: number) => (s.events[n >> 3] & (0x80 >> (n & 7))) !== 0;
const eventsSet = (s: OwState) => s.events.flatMap((b, i) => Array.from({ length: 8 }, (_, k) => (b & (0x80 >> k) ? [i * 8 + k] : [])).flat());

// a game in progress (two players: `twoPlayers`) on the overworld tile of 105, the level entered and left through
// the exit of Mario's screen into entrance `idx`, until the overworld runs again (its event shown): the
// overworld then, or null
function leave(r: Rom, idx: number, twoPlayers = false): { before: OwState; after: OwState; mode: number } | null {
  const e = new LevelEmulator(r);
  e.startGame(TL);
  const s = e.snes, w = s.wram;
  if (twoPlayers) { w[RAM.twoPlayers] = 1; w[RAM.playerLives + 1] = w[RAM.playerLives]; }
  const before = owState(w);
  e.loadInGame(N, TL);
  for (let f = 0; f < 600 && (w[RAM.gameMode] !== GM.level || w[RAM.marioAnim] !== 0); f++) s.runFrame();
  if (w[RAM.gameMode] !== GM.level) return null;
  const scr = w[RAM.marioX + 1];
  w[RAM.screenExitLo + scr] = idx & 0xff; w[RAM.screenExitHi + scr] = 0x04 | 0x02 | (idx >> 8);
  w[RAM.marioAnim] = 6; w[RAM.pipeTimer] = 0; w[RAM.pipeAction] = 0;
  let left = false, f = 0;
  for (; f < 900 && !(left && w[RAM.gameMode] === GM.overworld); f++) { s.runFrame(); if (w[RAM.gameMode] !== GM.level) left = true; }
  if (w[RAM.gameMode] !== GM.overworld) return null;
  // the overworld's events and walking (the player switch) run on for a while
  for (let k = 0; k < 600; k++) s.runFrame();
  return { before, after: owState(w), mode: w[RAM.gameMode] };
}
const IDX = new ExitGraph(rom).freeEntrance()!;
// a copy of the ROM with entrance IDX of level 105 to the overworld; `location`: sets up the teleport location
const withExit = (o: Partial<OverworldExit>, location?: (r: Rom) => number): Rom => {
  const r = new Rom(rom.data.slice());
  const at = location?.(r);
  writeSecondaryEntrance(r, IDX, { ...decodeSecondaryEntrance([0, 0, 0, 0, 0, 0]), destLevel: N, overworld: { ...newOverworldExit(), ...o, ...(at === undefined ? {} : { location: at }) } });
  return r;
};
const base = rom.r8(BASE_EVENTS + TL);
{
  const none = leave(withExit({ action: OW_NOTHING }), IDX);
  check(!!none && none.after.submap === none.before.submap && none.after.x === none.before.x && none.after.y === none.before.y && !eventsSet(none.after).length,
    `do nothing: back on the tile of 105 (${JSON.stringify(none && { ...none.after, events: eventsSet(none.after) })}), no event`);
  const normal = leave(withExit({ action: OW_NORMAL }), IDX);
  check(!!normal && eventsSet(normal.after).join() === String(base), `normal exit: event ${hx(base)} (the tile's), got ${normal && eventsSet(normal.after).map(hx)}`);
  const secret = leave(withExit({ action: OW_SECRET }), IDX);
  check(!!secret && eventsSet(secret.after).join() === String(base + 1), `secret exit: event ${hx(base + 1)}, got ${secret && eventsSet(secret.after).map(hx)}`);
  const own = leave(withExit({ action: OW_NORMAL, ownEvent: 1, event: 0x12 }), IDX);
  check(!!own && eventsSet(own.after).join() === '18', `another base event: event 12, got ${own && eventsSet(own.after).map(hx)}`);
  const ownSecret = leave(withExit({ action: OW_SECRET, ownEvent: 1, event: 0x12 }), IDX);
  check(!!ownSecret && eventsSet(ownSecret.after).join() === '19', `another base event, secret exit: event 13, got ${ownSecret && eventsSet(ownSecret.after).map(hx)}`);

  // teleported: to a location of its own (a tile of the main map's path) and to a star's destination
  const tile: OwTile = { submap: 0, x: 0x0c, y: 0x09 };
  let loc = -1;
  const tl = leave(withExit({ action: OW_NOTHING, teleport: 1 }, (r) => (loc = locationFor(r, tile)!)), IDX);
  check(!!tl && tl.after.submap === 0 && tl.after.x === tile.x && tl.after.y === tile.y && !eventsSet(tl.after).length,
    `teleport to location ${hx(loc)} (main map 0C,09): ${JSON.stringify(tl && { ...tl.after, events: eventsSet(tl.after) })}`);
  const star = readTeleport(rom, 3).to!;
  const ts = leave(withExit({ action: OW_NORMAL, teleport: 1, location: 3 }), IDX);
  check(!!ts && ts.after.submap === star.submap && ts.after.x === star.x && ts.after.y === star.y && eventsSet(ts.after).join() === String(base),
    `teleport to star 3's destination with the normal exit: ${JSON.stringify(ts && { ...ts.after, events: eventsSet(ts.after) })}, event ${hx(base)}`);

  // two players: ending the turn switches to Luigi, the others don't
  const end = leave(withExit({ action: OW_END_TURN }), IDX, true);
  const stay = leave(withExit({ action: OW_NOTHING }), IDX, true);
  check(!!end && !!stay && end.before.player === 0 && end.after.player === 1 && stay.after.player === 0 && !eventsSet(end.after).length,
    `end the turn: player ${end?.after.player} (do nothing: ${stay?.after.player})`);
  // an entrance into a level still leads there
  const lv = new LevelEmulator(rom);
  lv.startGame(TL);
  lv.loadInGame(N, TL);
  const w = lv.snes.wram;
  for (let f = 0; f < 600 && (w[RAM.gameMode] !== GM.level || w[RAM.marioAnim] !== 0); f++) lv.snes.runFrame();
  const scr = w[RAM.marioX + 1];
  w[RAM.screenExitLo + scr] = 0xcb; w[RAM.screenExitHi + scr] = 0x04 | 0x02 | 1;
  w[RAM.marioAnim] = 6; w[RAM.pipeTimer] = 0; w[RAM.pipeAction] = 0;
  let left = false;
  for (let f = 0; f < 900 && !(left && w[RAM.gameMode] === GM.level); f++) { lv.snes.runFrame(); if (w[RAM.gameMode] !== GM.level) left = true; }
  check(w[RAM.gameMode] === GM.level, 'an entrance into a level (1CB) still loads it');
}

// the game's star and pipe warps: the entry of each tile (found by the patch's search) and where it leads, as
// in the clean game
{
  const find = rom.r24(FIND_HOOK + 1);
  const ed = new LevelEmulator(rom), cl = new LevelEmulator(clean);
  const differ: string[] = [];
  const at = (e: LevelEmulator, sub: number, x: number, y: number) => {
    const w = e.snes.wram;
    w[RAM.playerIndex] = 0; w[RAM.currentPlayer] = 0; w[RAM.submap] = sub;
    w[RAM.owPlayerTileX] = x; w[RAM.owPlayerTileX + 1] = 0; w[RAM.owPlayerTileY] = y; w[RAM.owPlayerTileY + 1] = 0;
  };
  ed.startGame(0); cl.startGame(0);
  const ow = ed.snes.saveState(), owc = cl.snes.saveState();
  for (let i = 0; i < 27; i++) {
    const [fx, fy] = gameEntry(i);
    // the game's search: the last entry of the tile
    let want = -1;
    for (let k = 26; k >= 0; k--) { const [kx, ky] = gameEntry(k); if (kx === fx && ky === fy) { want = k; break; } }
    at(ed, fx >> 8, fx & 0xff, fy);
    ed.snes.wram[RAM.owWarpIndex] = 0xee;
    ed.call(find, 0);
    const got = ed.snes.wram[RAM.owWarpIndex];
    // where it leads: the overworld loaded with the warp (the game's $1DF6 a word offset, the patch's the entry)
    const go = (e: LevelEmulator, st: typeof ow, v: number) => {
      e.snes.loadState(st);
      const w = e.snes.wram;
      w[RAM.owWarpIndex] = v; w[RAM.owWarp] = 1; w[RAM.gameMode] = GM.overworldLoad;
      for (let f = 0; f < 400 && w[RAM.gameMode] !== GM.overworld; f++) e.snes.runFrame();
      return JSON.stringify({ ...owState(w), events: undefined, x: get16(w, RAM.owPlayerX), y: get16(w, RAM.owPlayerY) });
    };
    const a = go(cl, owc, want * 2), b = go(ed, ow, got);
    if (got !== want || a !== b) differ.push(`${i}: entry ${got} (${want}) ${b} / ${a}`);
  }
  at(ed, 0, 0, 0);
  ed.snes.wram[RAM.owWarpIndex] = 0xee;
  ed.call(find, 0);
  check(!differ.length && ed.snes.wram[RAM.owWarpIndex] === 0xee, `the game's 27 star/pipe tiles warp as in the clean game, other tiles not ${differ.join('; ')}`);
}

// a warp from a tile of the extended table's entries above the game's: found and leading there
{
  const r = new Rom(rom.data.slice());
  writeTeleport(r, 0xf0, { from: { submap: 0, x: 0x0c, y: 0x09 }, to: { submap: 2, x: 5, y: 6 } });
  const e = new LevelEmulator(r);
  e.startGame(0);
  const w = e.snes.wram;
  w[RAM.playerIndex] = 0; w[RAM.currentPlayer] = 0; w[RAM.submap] = 0;
  w[RAM.owPlayerTileX] = 0x0c; w[RAM.owPlayerTileY] = 0x09; w[RAM.owPlayerTileX + 1] = w[RAM.owPlayerTileY + 1] = 0;
  e.call(r.r24(FIND_HOOK + 1), 0);
  const found = w[RAM.owWarpIndex];
  w[RAM.owWarp] = 1; w[RAM.gameMode] = GM.overworldLoad;
  for (let f = 0; f < 400 && w[RAM.gameMode] !== GM.overworld; f++) e.snes.runFrame();
  const s = owState(w);
  check(found === 0xf0 && s.submap === 2 && s.x === 5 && s.y === 6, `entry F0: found (${hx(found)}), Mario on submap ${s.submap} at ${s.x},${s.y}`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
