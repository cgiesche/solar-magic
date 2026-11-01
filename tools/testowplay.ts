// Test play from the overworld (issue #87, core/playsession.ts fromOverworld): a new game at the overworld view's
// event progress – the event bits as the view loads them, the layer 1 the view shows, the levels whose exits ran the
// passed events passed with their exit's path open (owevents.ts progressLevelFlags) – with Mario on the selected
// layer 1 tile (or at the start position) and the overworld loaded where he stands; a level entered from there is
// the ROM's (an edit saved shows). The level editor's test play from a tile (PlaySession.test, moved from
// ui/testplay.ts) still puts Mario at the tile.
// node tools/testowplay.ts
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import {
  OverworldEmulator, readTranslevels, readL1, isLevelTile, l1XY, baseEvent, eventBits, exitDirections, DIR_FLAGS, FLAG, OW_EVENTS, gameL1,
} from '../src/core/overworld.ts';
import { progressLevelFlags, eventRunners } from '../src/core/owevents.ts';
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

// ---- at an event progress: Yoshi's Island 1's normal exit passed ----
const e = baseEvent(rom, TL), n = e + 1, dir = exitDirections(rom, TL)[0];
{
  const flags = progressLevelFlags(rom, n), runners = eventRunners(rom);
  const before = [...runners].filter(([ev]) => ev < n).map(([, rs]) => rs[0].tl);
  check(flags.get(TL) === (FLAG.passed | DIR_FLAGS[dir]) && [...flags.keys()].every((t) => before.includes(t)),
    `progress ${hx(n)}: level 105 passed, its normal exit's direction open (${hx(flags.get(TL) ?? 0)}); only levels of passed events (${[...flags.keys()].map(hx).join(' ')})`);
  check(progressLevelFlags(rom, 0).size === 0 && progressLevelFlags(rom, OW_EVENTS).size >= 0x40, `none at progress 0, every level with an event at all (${progressLevelFlags(rom, OW_EVENTS).size})`);
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
  const p = PlaySession.fromOverworld(emu, tile, n);
  const ev = w.slice(RAM.owEvents, RAM.owEvents + OW_EVENTS / 8);
  check(same(ev, eventBits(n)), `progress ${hx(n)}: the event bits of events 00–${hx(e)}`);
  check(same(owL1(), gameL1(owe.load(1, n))), 'layer 1 as the view shows it at that progress');
  check((w[RAM.levelFlags + TL] & (FLAG.passed | DIR_FLAGS[dir])) === (FLAG.passed | DIR_FLAGS[dir]), 'level 105 passed in the game');
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
  const p = PlaySession.fromOverworld(emu, tile, n);
  check(p.enter('settled') && goombas() === 0, `level 105 entered from its tile: no Goomba in it (${goombas()})`);
  p.close();
  const lv = cloneLevel(loadLevel(rom, 0x105));
  lv.sprites.push({ uid: newUid(), x: 0x0a, y: 0x16, num: GOOMBA, extra: 0 });
  saveLevel(rom, lv);
  const q = PlaySession.fromOverworld(emu, tile, n);
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
