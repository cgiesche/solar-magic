// Test play from the overworld (issue #87, core/playsession.ts fromOverworld): a new game at the overworld view's
// event progress – the event bits as the view loads them, the layer 1 the view shows, the save learned for it by
// emulation (#255, owprogress.ts progressSaves: each event's level left with its exit as the game does, the game's
// code setting the level flags, running the event and counting it) – with Mario on the selected layer 1 tile (or at
// the start position) and the overworld loaded where he stands; a level entered from there is the ROM's (an edit
// saved shows). The level editor's test play from a tile (PlaySession.test, moved from ui/testplay.ts) still puts
// Mario at the tile.
// node tools/testowplay.ts
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import {
  OverworldEmulator, OverworldLoads, readTranslevels, readL1, isLevelTile, l1XY, baseEvent, setBaseEvent, eventBits, exitDirections, DIR_FLAGS, FLAG,
  OW_EVENTS, gameL1,
} from '../src/core/overworld.ts';
import { eventRunners } from '../src/core/owevents.ts';
import { progressSaves } from '../src/core/owprogress.ts';
import { loadLevel, cloneLevel, newUid } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { GM, RAM, SPR, PAD, get16, getS16, marioX, marioY } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

const rom = new Rom(await editorImage());
const emu = new LevelEmulator(rom), w = emu.snes.wram;
const owe = new OverworldEmulator(rom);
const TL = 0x29; // Yoshi's Island 1, on submap 1
const tls = readTranslevels(rom), l1 = readL1(rom);
const tile = tls.indexOf(TL);
const tileOf = () => ({ x: get16(w, RAM.owPlayerTileX), y: get16(w, RAM.owPlayerTileY) });
const owL1 = () => w.slice(RAM.owLayer1, RAM.owLayer1End);

// ---- the selected tile, no events ----
{
  const p = PlaySession.fromOverworld(emu, tile, 0);
  const t = tileOf(), at = l1XY(tile), shown = owe.load(1, 0);
  check(p.mode === GM.overworld && !p.ready, `on the overworld (mode ${hx(p.mode)})`);
  check(t.x === at.x && t.y === at.y && w[RAM.submap] === 1, `Mario on level 105's tile ${hx(at.x)},${hx(at.y)} on submap 1 (${hx(t.x)},${hx(t.y)}, submap ${w[RAM.submap]})`);
  check(get16(w, RAM.layer2X) === get16(shown.wram, RAM.layer2X) && get16(w, RAM.layer2Y) === get16(shown.wram, RAM.layer2Y), 'the submap loaded: its camera as the view\'s');
  check(same(owL1(), gameL1(shown)) && w.subarray(RAM.owEvents, RAM.owEvents + OW_EVENTS / 8).every((b) => !b), 'no event passed, layer 1 as the view shows it');
  p.close();
}

// ---- the save at each event progress, learned by emulation ----
const e = baseEvent(rom, TL), n = e + 1, dir = exitDirections(rom, TL)[0];
const saves = progressSaves(new OverworldLoads(new OverworldEmulator(rom), 4));
{
  const fresh = new OverworldEmulator(rom).load(0, 0).wram;
  const flagsAt0 = [...fresh.subarray(RAM.levelFlags, RAM.levelFlags + 0x60)];
  check(saves.length === OW_EVENTS + 1 && same(saves[0].levelFlags, flagsAt0) && saves[0].eventsTriggered === 0 && saves[0].switchPalaces.every((v) => !v),
    'progress 0: a new file\'s save');
  check((saves[n].levelFlags[TL] & (FLAG.passed | DIR_FLAGS[dir])) === (FLAG.passed | DIR_FLAGS[dir]) && !(saves[e].levelFlags[TL] & FLAG.passed),
    `progress ${hx(n)}: level 105 passed, its normal exit's direction open (${hx(saves[n].levelFlags[TL])}), not at ${hx(e)}`);
  // the rule test play used before (#87): each level whose exit of the lowest number runs a passed event is passed, the
  // path in that exit's direction open – right where an event has one such level (the game passes one of two)
  const runners = eventRunners(rom), off: string[] = [], shared = new Set<number>();
  for (const rs of runners.values()) { const first = rs.filter((r) => r.exit === rs[0].exit); if (first.length > 1) first.forEach((r) => shared.add(r.tl)); }
  for (let p = 0; p <= OW_EVENTS; p++) {
    const want = new Map<number, number>();
    for (const [ev, rs] of runners) {
      const first = rs.filter((r) => r.exit === rs[0].exit);
      if (ev < p && first.length === 1) want.set(rs[0].tl, (want.get(rs[0].tl) ?? 0) | FLAG.passed | DIR_FLAGS[exitDirections(rom, rs[0].tl)[rs[0].exit]]);
    }
    for (let tl = 0; tl < 0x60; tl++) {
      const got = saves[p].levelFlags[tl], w = want.get(tl) ?? 0;
      if ((got & w) !== w || ((got & FLAG.passed) && !w && !shared.has(tl) && !(flagsAt0[tl] & FLAG.passed))) off.push(`${hx(p)}/${hx(tl)}: ${hx(got)} for ${hx(w)}`);
    }
  }
  check(!off.length, `every progress 00–78 of the clean game: the levels passed and the directions open as the rule gave them (the game opens more) ${off.slice(0, 6).join(' ')}`);
  const counts = saves.map((v) => v.eventsTriggered);
  check(counts.every((c, p) => !p || c - counts[p - 1] === 0 || c - counts[p - 1] === 1) && counts[0x60] === 0x60,
    `events triggered follow the progress: one more with each event the game runs (${hx(counts[0x10])} at 10, ${hx(counts[0x60])} at 60, ${hx(counts[OW_EVENTS])} at 78)`);
  // (the switch palaces are pressed in their levels, not learned yet: #257)
  check(saves.every((v) => v.switchPalaces.every((x) => !x)), 'switch palaces: a new file\'s at every progress (#257)');
}
// two levels running the same event with their normal exit: only the one the game marks passed
{
  const r2 = new Rom(rom.data.slice()), other = 0x2a; // Yoshi's Island 2
  setBaseEvent(r2, other, e);
  const v = progressSaves(new OverworldLoads(new OverworldEmulator(r2), 4))[n];
  const passed = [TL, other].filter((t) => v.levelFlags[t] & FLAG.passed);
  check(baseEvent(r2, other) === e && passed.length === 1 && passed[0] === TL && v.eventsTriggered === n,
    `Yoshi's Island 2 also running event ${hx(e)}: only level 105 passed (${passed.map(hx).join(' ')}), ${v.eventsTriggered} events triggered`);
}
const walk = (p: PlaySession, pad: number) => {
  const from = tileOf();
  for (let f = 0; f < 120; f++) p.frame(f < 8 ? pad : 0); // (on the overworld: play() ends at once, it is no level)
  const to = tileOf();
  return to.x !== from.x || to.y !== from.y;
};
const PADS = [PAD.up, PAD.down, PAD.left, PAD.right];
{
  const p = PlaySession.fromOverworld(emu, tile, 0);
  const moved = walk(p, PADS[dir]);
  check(!moved, `progress 0: no way from level 105 ${['up', 'down', 'left', 'right'][dir]}`);
  p.close();
}
{
  const p = PlaySession.fromOverworld(emu, tile, n, saves[n]);
  const ev = w.slice(RAM.owEvents, RAM.owEvents + OW_EVENTS / 8);
  check(same(ev, eventBits(n)), `progress ${hx(n)}: the event bits of events 00–${hx(e)}`);
  check(same(owL1(), gameL1(owe.load(1, n))), 'layer 1 as the view shows it at that progress');
  check((w[RAM.levelFlags + TL] & (FLAG.passed | DIR_FLAGS[dir])) === (FLAG.passed | DIR_FLAGS[dir]) && w[RAM.eventsTriggered] === saves[n].eventsTriggered,
    `level 105 passed in the game, ${w[RAM.eventsTriggered]} events triggered as learned`);
  check(walk(p, PADS[dir]), `Mario walks from level 105 ${['up', 'down', 'left', 'right'][dir]} along the revealed path (to ${hx(tileOf().x)},${hx(tileOf().y)})`);
  p.close();
}

// ---- a main map tile; no selection: the start position ----
{
  const i = [...tls.keys()].find((k) => k < 0x400 && tls[k] && isLevelTile(l1[k]))!;
  const p = PlaySession.fromOverworld(emu, i, 0), at = l1XY(i), t = tileOf();
  const px = get16(w, RAM.owPlayerX), py = get16(w, RAM.owPlayerY), cx = getS16(w, RAM.layer1X), cy = getS16(w, RAM.layer1Y);
  check(t.x === at.x && t.y === at.y && w[RAM.submap] === 0, `a main map level tile ${hx(at.x)},${hx(at.y)}: Mario there, on the main map`);
  check(px >= cx && px < cx + 256 && py >= cy && py < cy + 224, `the camera shows him (Mario ${px},${py}, camera ${cx},${cy})`);
  p.close();
}
{
  emu.startGameAt(-1);
  const start = { ...tileOf(), sub: w[RAM.submap] };
  const p = PlaySession.fromOverworld(emu, -1, 0), t = tileOf();
  check(t.x === start.x && t.y === start.y && w[RAM.submap] === start.sub && p.mode === GM.overworld, `no tile: at the start position ${hx(t.x)},${hx(t.y)}`);
  p.close();
}

// ---- a level entered from there: the ROM's, as edited ----
const GOOMBA = 0x0f;
const goombas = () => Array.from({ length: 12 }, (_, k) => k).filter((k) => w[SPR.status + k] && w[SPR.num + k] === GOOMBA).length;
{
  const p = PlaySession.fromOverworld(emu, tile, n, saves[n]);
  check(p.enter('settled') && goombas() === 0, `level 105 entered from its tile: no Goomba in it (${goombas()})`);
  p.close();
  const lv = cloneLevel(loadLevel(rom, 0x105));
  lv.sprites.push({ uid: newUid(), x: 0x0a, y: 0x16, num: GOOMBA, extra: 0 });
  saveLevel(rom, lv);
  const q = PlaySession.fromOverworld(emu, tile, n, saves[n]);
  check(q.enter('settled') && goombas() === 1, `a Goomba added and saved: entered from the overworld, it is there (${goombas()})`);
  q.close();
}

// ---- the level editor's test play from a tile (moved into core) ----
{
  const lv = loadLevel(rom, 0x105), tx = 0x24, ty = 0x18;
  const p = PlaySession.test(emu, 0x105, { at: { tx, ty, level: { secondary: lv.secondary, maxScreen: lv.header.screens - 1, rows: 0 } } });
  check(p.ready && marioX(w) === tx * 16 && marioY(w) === ty * 16 - 16, `level 105 from tile ${hx(tx)},${hx(ty)}: Mario there (${marioX(w)},${marioY(w)})`);
  p.close();
  const m = PlaySession.test(emu, 0x105, { show: { message: 1, yoshi: false } });
  check(m.ready && w[RAM.message] === 1, 'with a message box: it is set once the level runs');
  m.close();
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
