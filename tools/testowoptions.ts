// The overworld options (owoptions.ts, Lunar Magic's "Extra Options"): each switch turned on and off writes Lunar
// Magic's bytes or the clean game's, is one ROM edit that undo takes back, and the game behaves accordingly – checked
// by emulation per option.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { readL1, readTranslevels, setInitialFlags, FLAG } from '../src/core/overworld.ts';
import { OW_OPTIONS, owOptionValue, setOwOption, revealSpeed, setRevealSpeed, DEFAULT_REVEAL_SPEED, MAX_REVEAL_SPEED, revealStepFrames, type OwOptionId } from '../src/core/owoptions.ts';
import { GM, RAM, PAD, get16, set16 } from '../src/core/ram.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const hx = (v: number) => v.toString(16).toUpperCase();

const clean = new Rom(cleanImage());
const image = await editorImage();
const fresh = () => new Rom(image.slice());
const tls = readTranslevels(fresh()), l1 = readL1(fresh());
const tileOf = (tl: number) => tls.indexOf(tl);
const with_ = (id: OwOptionId, on: boolean) => { const rom = fresh(); setOwOption(rom, id, on); return rom; };

// ---- bytes: the game's in the editor's ROM, Lunar Magic's when changed, the game's again when turned back ----
{
  const rom = fresh();
  for (const o of OW_OPTIONS) {
    const was = rom.data.slice();
    check(owOptionValue(rom, o.id) === o.game, `${o.id}: the editor's ROM has the game's (${o.game})`);
    const inClean = o.bytes.filter((b) => b.at < 0x030000 || b.at >= 0x040000);
    check(inClean.every((b) => same(clean.bytes(b.at, b.game.length), b.game)), `${o.id}: the clean game's bytes are the game's`);
    const s = new RomEditSession(rom);
    s.edit(o.label, () => setOwOption(rom, o.id, !o.game));
    check(owOptionValue(rom, o.id) === !o.game && o.bytes.every((b) => same(rom.bytes(b.at, b.changed.length), b.changed)), `${o.id}: changed to Lunar Magic's bytes`);
    s.edit(o.label, () => setOwOption(rom, o.id, o.game));
    check(same(rom.data, was), `${o.id}: turned back, the bytes are the game's again`);
    s.undo(); s.undo();
    check(same(rom.data, was) && owOptionValue(rom, o.id) === o.game, `${o.id}: undone`);
  }
  // a patch's bytes in a place: neither
  rom.w8(0x049307, 0xea);
  check(owOptionValue(rom, 'hardcodedPaths') === null, 'changed by a patch: unknown');
  let threw = false;
  try { setOwOption(rom, 'hardcodedPaths', false); } catch { threw = true; }
  check(threw && rom.r8(0x049307) === 0xea, 'not written then');
}

// ---- Start+Select on a passed level ----
// a new game on the tile of translevel tl (its flags | `flags`), the level entered; then paused and Select held: left
function startSelect(rom: Rom, tl: number): boolean {
  const p = PlaySession.overworld(new LevelEmulator(rom), tileOf(tl));
  p.wram[RAM.levelFlags + tl] |= FLAG.passed | 0x0f;
  if (!p.enter()) throw new Error('not entered');
  p.play(30);
  p.frame(PAD.start); p.frame(PAD.start);
  for (let f = 0; f < 20; f++) p.frame();
  const was = p.wram[RAM.paused];
  for (let f = 0; f < 20; f++) { p.frame(PAD.select); if (p.wram[RAM.levelExit] === 0x80) return true; }
  if (!was) throw new Error('not paused');
  return false;
}
{
  const tl = 0x29; // Yoshi's Island 1
  check(startSelect(fresh(), tl), 'Start+Select: a passed level is left');
  check(!startSelect(with_('startSelect', false), tl), 'Start+Select off: not left');
}

// ---- Start on the main map ----
// a new game on tile i: whether Start looks around the map
function startScroll(rom: Rom, i: number): boolean {
  const p = PlaySession.overworld(new LevelEmulator(rom), i);
  for (let f = 0; f < 20; f++) p.frame();
  for (let f = 0; f < 30; f++) { p.frame(f < 2 ? PAD.start : 0); if (p.wram[RAM.paused]) return true; }
  return false;
}
{
  const main = tls.findIndex((t, i) => t > 0 && i < 0x400);
  check(startScroll(fresh(), main), `Start: looks around the main map (tile ${hx(main)})`);
  check(!startScroll(with_('startScroll', false), main), 'Start scroll off: not');
}

// ---- the hardcoded paths ----
// a new game on translevel tl's tile, all its directions enabled: the directions in which Mario walks a hardcoded path
function hardcoded(rom: Rom, tl: number): string[] {
  const got: string[] = [];
  for (const [name, pad] of [['up', PAD.up], ['down', PAD.down], ['left', PAD.left], ['right', PAD.right]] as const) {
    const p = PlaySession.overworld(new LevelEmulator(rom), tileOf(tl));
    p.wram[RAM.levelFlags + tl] |= FLAG.passed | 0x0f;
    for (let f = 0; f < 10; f++) p.frame();
    let on = false;
    for (let f = 0; f < 60; f++) { p.frame(f < 4 ? pad : 0); if (p.wram[RAM.owHardcodedPath]) on = true; }
    if (on) got.push(name);
  }
  return got;
}
{
  for (const tl of [0x09, 0x23]) {
    const on = hardcoded(fresh(), tl), off = hardcoded(with_('hardcodedPaths', false), tl);
    check(on.length > 0 && off.length === 0, `hardcoded paths: from translevel ${hx(tl)} one walked (${on.join(' ')}), off none (${off.join(' ')})`);
  }
}

// ---- the event path fade, the reveal speed ----
// a new game on translevel tl's tile, the level passed with its normal exit: the frames between the steps the
// overworld shows ($1DEB) and the layer 2 tilemap ($7F4000) when the event has run
function reveal(rom: Rom, tl: number): { gaps: number[]; l2: Uint8Array } {
  const p = PlaySession.overworld(new LevelEmulator(rom), tileOf(tl));
  if (!p.enter()) throw new Error('not entered');
  const w = p.wram;
  w[RAM.levelExit] = 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1;
  w[RAM.gameMode] = GM.overworldReturn;
  p.follow();
  const at: number[] = [];
  let step = get16(w, RAM.owEventStep);
  for (let f = 0; f < 900; f++) {
    p.frame();
    const s = get16(w, RAM.owEventStep);
    if (s !== step) { at.push(f); step = s; }
  }
  return { gaps: at.slice(1).map((f, k) => f - at[k]), l2: w.slice(0x14000, 0x16000) };
}
{
  const tl = 0x29;
  const fade = reveal(fresh(), tl);
  const rom = with_('pathFade', false);
  check(revealSpeed(fresh()) === null && revealSpeed(rom) === DEFAULT_REVEAL_SPEED, `reveal speed: none with the fade, ${DEFAULT_REVEAL_SPEED} (Lunar Magic's) without`);
  const off = reveal(rom, tl);
  setRevealSpeed(rom, MAX_REVEAL_SPEED);
  const fast = reveal(rom, tl);
  const steps = (r: { gaps: number[] }) => r.gaps.join(',');
  check(fade.gaps.length > 2 && off.gaps.length === fade.gaps.length && fast.gaps.length === fade.gaps.length,
    `the same steps with and without the fade (${fade.gaps.length + 1})`);
  const want = (r: Rom) => revealStepFrames(r);
  check(fade.gaps.every((g) => g === want(fresh())), `with the fade a step every ${want(fresh())} frames (${steps(fade)})`);
  check(off.gaps.every((g) => g === Math.ceil(0x40 / DEFAULT_REVEAL_SPEED) + 2) && fast.gaps.every((g) => g === want(rom)),
    `without the fade a step every $40 / speed frames + 2: speed ${DEFAULT_REVEAL_SPEED}: ${steps(off)}; ${hx(MAX_REVEAL_SPEED)}: ${steps(fast)}`);
  check(same(fade.l2, off.l2) && same(fade.l2, fast.l2), 'the same layer 2 after the event');
  let threw = false;
  try { setRevealSpeed(fresh(), 3); } catch { threw = true; }
  check(threw, 'no reveal speed with the fade on');
}

// ---- the save prompt ----
// a new game on tile i, the level passed with its normal exit: whether the save prompt came up; the copy of the
// overworld's state made for the save
function pass(rom: Rom, i: number, setup: (w: Uint8Array) => void = () => {}): { prompt: boolean; copy: Uint8Array } {
  const p = PlaySession.overworld(new LevelEmulator(rom), i);
  setup(p.wram);
  if (!p.enter()) throw new Error('not entered');
  const w = p.wram;
  w[RAM.levelExit] = 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1;
  w[RAM.gameMode] = GM.overworldReturn;
  let prompt = false;
  p.follow();
  for (let k = 0; k < 600; k++) { p.frame(); if (w[RAM.savePrompt]) prompt = true; }
  return { prompt, copy: w.slice(RAM.saveCopy, RAM.saveCopy + 0x2d) };
}
const castle = [...l1.keys()].find((i) => l1[i] === 0x63 && tls[i])!;
{
  check(pass(fresh(), castle).prompt, `a castle (tile ${hx(castle)}) brings up the save prompt`);
  const rom = with_('savePrompt', false);
  check(!pass(rom, castle).prompt, 'save prompt off: not');
  setInitialFlags(rom, tls[castle], FLAG.savePrompt);
  check(pass(rom, castle).prompt, 'off, the level tile\'s own save prompt flag still brings it up');
  // (the event after a castle: its save as in the game)
}

// ---- Luigi's position saved ----
{
  const luigiX = RAM.saveCopy + (RAM.owPlayerX + RAM.owPlayerStride - RAM.owEvents);
  const marioX = RAM.saveCopy + (RAM.owPlayerX - RAM.owEvents);
  // a 2-player game, Luigi 3 tiles right of Mario
  const two = (w: Uint8Array) => {
    w[RAM.twoPlayers] = 1;
    set16(w, RAM.owPlayerX + RAM.owPlayerStride, get16(w, RAM.owPlayerX) + 0x30);
    set16(w, RAM.owPlayerTileX + RAM.owPlayerStride, get16(w, RAM.owPlayerTileX) + 3);
  };
  const game = pass(fresh(), castle, two), own = pass(with_('saveLuigi', true), castle, two);
  const x = (r: { copy: Uint8Array }, at: number) => get16(r.copy, at - RAM.saveCopy);
  check(game.prompt && x(game, luigiX) === x(game, marioX), `the game saves Mario's position for Luigi (${hx(x(game, luigiX))})`);
  check(own.prompt && x(own, luigiX) === x(own, marioX) + 0x30, `saving Luigi's position: his own (${hx(x(own, luigiX))}, Mario ${hx(x(own, marioX))})`);
}

// ---- life exchange ----
// a 2-player game on the overworld, L pressed: the highest value of the life exchange window's counter
function exchange(rom: Rom): number {
  const p = PlaySession.overworld(new LevelEmulator(rom), castle);
  const w = p.wram;
  w[RAM.twoPlayers] = 1;
  for (let f = 0; f < 10; f++) p.frame();
  let max = 0;
  for (let f = 0; f < 60; f++) { p.frame(f < 2 ? PAD.l : 0); max = Math.max(max, w[RAM.lifeExchange]); }
  return max;
}
{
  const game = exchange(fresh());
  const noLR = exchange(with_('lrExchange', false));
  const none = with_('lifeExchange', false);
  const no = exchange(none);
  check(game > 1, `L opens the life exchange (${game})`);
  check(noLR === 0, `L/R off: not opened (${noLR})`);
  check(no <= 1, `life exchange off: L asks, nothing opens (${no})`);
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('overworld options ok');
