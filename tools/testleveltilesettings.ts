// Level tile settings (overworld.ts, Lunar Magic's "Modify Level Tile Settings"): the base event, the direction
// each exit reveals, the initial level flags with Lunar Magic's "no entry if passed" and "save prompt" (the
// editor's patch in Lunar Magic's places) and the events that reveal a tile. Checked by emulation: a new game
// starts with the flags of the clean game and those set, passing a level with each exit enables the direction
// set, a passed level with "no entry" can't be entered, one with "save prompt" brings it up, a tile set to be
// revealed by an event is.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import {
  OverworldEmulator, readL1, readTranslevels, hasLevelFlagsPatch, initialFlags, setInitialFlags, exitDirections, setExitDirection,
  baseEvent, setBaseEvent, revealEvents, setRevealEvents, revealAt, revealedTile, resetTranslevel, translevelUse, FLAG, DIR_FLAGS, MAX_TRANSLEVEL, OW_EVENTS,
} from '../src/core/overworld.ts';
import { GM, RAM, PAD } from '../src/core/ram.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { cleanImage, editorImage, levelTiles } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const hx = (v: number) => v.toString(16).toUpperCase();

const clean = new Rom(cleanImage());
const image = await editorImage();
const TL = 0x29; // Yoshi's Island 1
const tile = readTranslevels(new Rom(image.slice())).indexOf(TL);

// the flags of every translevel in a new game ($1EA2 on the overworld)
const newGameFlags = (rom: Rom) => new OverworldEmulator(rom).load(0, 0).wram.slice(RAM.levelFlags, RAM.levelFlags + MAX_TRANSLEVEL + 1);

// the translevel ($13BF) the game enters from tile i in a new game (A pressed on it); null: none entered
function enter(emu: LevelEmulator, i: number): number | null {
  emu.startGameAt(i);
  const s = emu.snes, w = s.wram;
  for (let f = 0; f < 400; f++) {
    s.joy1 = f % 8 < 2 ? PAD.a : 0;
    s.runFrame();
    if (w[RAM.gameMode] === GM.levelLoad) { s.joy1 = 0; return w[RAM.translevel]; }
  }
  s.joy1 = 0;
  return null;
}
// a new game, the level of tile i entered and passed with `exit` (1 normal, 2–4 secret exits 1–3), until the
// overworld has run its event: the translevel's flags before and after, whether the save prompt came up
function pass(rom: Rom, i: number, exit: number): { before: number; after: number; prompt: boolean } | null {
  const p = PlaySession.overworld(new LevelEmulator(rom), i);
  if (!p.enter()) return null;
  const w = p.wram, tl = w[RAM.translevel];
  const before = w[RAM.levelFlags + tl];
  // as a goal: the level passed with the exit, the overworld loaded after it
  w[RAM.levelExit] = exit; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1;
  w[RAM.gameMode] = GM.overworldReturn;
  let prompt = false;
  p.follow();
  for (let k = 0; k < 600; k++) { p.frame(); if (w[RAM.savePrompt]) prompt = true; }
  return w[RAM.gameMode] === GM.overworld ? { before, after: w[RAM.levelFlags + tl], prompt } : null;
}

// ---- the patch, the initial flags ----
{
  const rom = new Rom(image.slice());
  check(!hasLevelFlagsPatch(clean) && hasLevelFlagsPatch(rom), 'the clean game has the list of 8, the patched one the table');
  const game = newGameFlags(clean);
  check(same(Array.from({ length: MAX_TRANSLEVEL + 1 }, (_, t) => initialFlags(rom, t)), game), 'the table holds the flags of the clean game\'s new file');
  check(same(newGameFlags(rom), game), `a new game starts with the clean game's flags (${[...game.keys()].filter((t) => game[t]).map((t) => `${hx(t)}:${hx(game[t])}`).join(' ')})`);
  setInitialFlags(rom, TL, FLAG.up | FLAG.left | FLAG.midway);
  setInitialFlags(rom, 0x5f, FLAG.passed | FLAG.right);
  const set = newGameFlags(rom);
  check(set[TL] === (FLAG.up | FLAG.left | FLAG.midway) && set[0x5f] === (FLAG.passed | FLAG.right), 'flags set: a new game starts with them');
  check(translevelUse(rom, 0x5f) === 1, 'initial flags count as settings of a free translevel');
  const s = new RomEditSession(rom), was = rom.data.slice();
  s.edit('Reset', () => resetTranslevel(rom, 0x5f));
  check(initialFlags(rom, 0x5f) === 0 && translevelUse(rom, 0x5f) === 0, 'reset: no initial flags');
  s.undo();
  check(same(rom.data, was), 'reset undone');
}

// ---- exit directions: passing with each exit enables the direction set ----
{
  const rom = new Rom(image.slice());
  check(baseEvent(rom, TL) < 0x70, `level 105 runs event ${hx(baseEvent(rom, TL))}`);
  const got: string[] = [];
  for (const dirs of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
    dirs.forEach((d, x) => setExitDirection(rom, TL, x, d));
    check(same(exitDirections(rom, TL), dirs), `exit directions written: ${dirs}`);
    for (let x = 0; x < 4; x++) {
      const r = pass(rom, tile, x + 1);
      const ok = !!r && (r.after & 0x0f) === ((r.before & 0x0f) | DIR_FLAGS[dirs[x]]) && (r.after & FLAG.passed) !== 0;
      if (!ok) got.push(`exit ${x + 1} dir ${dirs[x]}: ${r ? `${hx(r.before)} → ${hx(r.after)}` : 'not passed'}`);
    }
  }
  check(!got.length, `passing 105 with each of its 4 exits enables the direction set, by emulation ${got.join('; ')}`);
  // the base event: the event run is the one set (+ the secret exit)
  setBaseEvent(rom, TL, 0x40);
  check(baseEvent(rom, TL) === 0x40, 'base event written');
}

// ---- save prompt, no entry if passed ----
{
  const rom = new Rom(image.slice());
  const off = pass(rom, tile, 1);
  setInitialFlags(rom, TL, FLAG.savePrompt);
  const on = pass(rom, tile, 1);
  check(!!off && !!on && !off.prompt && on.prompt, `save prompt: none after passing 105 (${off?.prompt}), with the flag set brought up (${on?.prompt})`);
  // a tile of the game's list (here a castle, 63) still brings it up without the flag
  const l1 = readL1(rom), tls = readTranslevels(rom);
  const castle = [...l1.keys()].find((i) => l1[i] === 0x63 && tls[i])!;
  const c = pass(rom, castle, 1);
  check(!!c && c.prompt, `a castle (tile ${hx(castle)}, translevel ${hx(tls[castle])}) brings it up as in the game`);
  const e = new LevelEmulator(rom);
  setInitialFlags(rom, TL, FLAG.passed | FLAG.noEntry);
  check(enter(e, tile) === null, 'passed with "no entry": not entered');
  setInitialFlags(rom, TL, FLAG.passed);
  check(enter(e, tile) === TL, 'passed without "no entry": entered');
  setInitialFlags(rom, TL, FLAG.noEntry);
  check(enter(e, tile) === TL, '"no entry" not yet passed: entered');
  // on a submap (Mario's tile found with the submap's + $400)
  const sub = tls.findIndex((v, i) => v > 0 && i >= 0x400), stl = tls[sub];
  setInitialFlags(rom, stl, FLAG.passed);
  const subIn = enter(e, sub);
  setInitialFlags(rom, stl, FLAG.passed | FLAG.noEntry);
  check(subIn === stl && enter(e, sub) === null, `a submap's level tile (${hx(sub)}, translevel ${hx(stl)}): entered, with "no entry" once passed not`);
  // every other level tile still entered as without the patch's check (a star tile 5F with a translevel enters none:
  // A warps, as in the game)
  const isLevelTile = levelTiles(rom);
  const missed = [...tls.keys()].filter((i) => tls[i] && isLevelTile(l1[i]) && i % 7 === 0).filter((i) => enter(e, i) !== tls[i]);
  check(!missed.length, `other level tiles entered as before (${missed.map(hx).join(' ')})`);
}

// ---- reveal this tile on events ----
{
  const rom = new Rom(image.slice());
  const l1 = readL1(rom);
  const used = new Set(Array.from({ length: 0x70 }, (_, e) => revealAt(rom, e)));
  const all = new OverworldEmulator(rom).load(0, OW_EVENTS).wram;
  const at = [...l1.keys()].find((i) => i && i < 0x400 && revealedTile(rom, l1[i]) >= 0 && !used.has(i) && all[RAM.owLayer1 + i] === l1[i])!;
  const ev = Array.from({ length: 0x6f }, (_, e) => e).find((e) => !revealAt(rom, e))!;
  check(at !== undefined && ev !== undefined, `tile ${hx(at)} (${hx(l1[at])} → ${hx(revealedTile(rom, l1[at]))}), event ${hx(ev)} reveals none`);
  const game = all[RAM.owLayer1 + at];
  const s = new RomEditSession(rom);
  s.edit('Reveal', () => setRevealEvents(rom, at, [ev]));
  check(same(revealEvents(rom, at), [ev]), 'written and read back');
  const after = new OverworldEmulator(rom).load(0, OW_EVENTS).wram[RAM.owLayer1 + at];
  check(game === l1[at] && after === revealedTile(rom, l1[at]), `after all events: tile ${hx(game)} as before, ${hx(after)} revealed by event ${hx(ev)} (emulated)`);
  // another tile on the same event takes it over; the event list emptied removes it
  const other = [...l1.keys()].find((i) => i > at && !used.has(i))!;
  setRevealEvents(rom, other, [ev]);
  check(!revealEvents(rom, at).length && same(revealEvents(rom, other), [ev]), 'an event reveals one tile: set on another, it moves');
  setRevealEvents(rom, other, []);
  check(!revealEvents(rom, other).length && !revealAt(rom, ev), 'removed');
  check(!revealEvents(rom, 0).length, 'tile 0 is "none"');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('level tile settings ok');
