// The overworld options (owoptions.ts, Lunar Magic's "Extra Options"): each switch turned on and off writes Lunar
// Magic's bytes or the clean game's, is one ROM edit that undo takes back, and the game behaves accordingly – checked
// by emulation per option.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { RomEditSession } from '../src/core/romedit.ts';
import { readL1, readTranslevels, setInitialFlags, FLAG, OverworldEmulator, MAP_NAMES } from '../src/core/overworld.ts';
import { OW_OPTIONS, owOptionValue, setOwOption, submapLightning, setSubmapLightning, lightningEditLabel, LIGHTNING_MASK, revealSpeed, setRevealSpeed, DEFAULT_REVEAL_SPEED, MAX_REVEAL_SPEED, revealStepFrames, PATH_FADE_COLORS, pathFadeColors, type OwOptionId } from '../src/core/owoptions.ts';
import { GM, RAM, PAD, get16, set16 } from '../src/core/ram.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { setSubmapPalette, SUBMAP_PALETTE_SIZE } from '../src/core/submapgfx.ts';
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
    // (bank 3's place is in the editor's own save prompt routine, not in the clean game)
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
// the bytes Lunar Magic 3.71 saved with the option checked and unchecked (docs/research/lunar-magic-overworld-options.md)
{
  const lm: [OwOptionId, number, number[], number[]][] = [ // option, place, bytes with it on, with it off
    ['hardcodedPaths', 0x049307, [0xa6, 0x08], [0x80, 0x71]],
    ['saveLuigi', 0x048f9f, [0x80, 0x3b], [0xc2, 0x30]],
  ];
  for (const [id, at, on, off] of lm) {
    check(same(with_(id, true).bytes(at, on.length), on) && same(with_(id, false).bytes(at, off.length), off), `${id}: on and off, the bytes of a ROM Lunar Magic saved`);
  }
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
// and the colors that changed meanwhile (CGRAM at the end) and the palettes of the sprites shown
function reveal(rom: Rom, tl: number): { gaps: number[]; l2: Uint8Array; changed: Set<number>; cgram: Uint8Array; spritePals: Set<number> } {
  const p = PlaySession.overworld(new LevelEmulator(rom), tileOf(tl));
  if (!p.enter()) throw new Error('not entered');
  const w = p.wram;
  w[RAM.levelExit] = 1; w[RAM.midwayTouched] = 1; w[RAM.levelBeaten] = 1;
  w[RAM.gameMode] = GM.overworldReturn;
  p.follow();
  const at: number[] = [], cg = p.emu.snes.cgram, oam = p.emu.snes.oam, start = cg.slice();
  const changed = new Set<number>(), spritePals = new Set<number>();
  let step = get16(w, RAM.owEventStep);
  for (let f = 0; f < 900; f++) {
    p.frame();
    const s = get16(w, RAM.owEventStep);
    if (s !== step) { at.push(f); step = s; }
    for (let i = 0; i < 256; i++) if (cg[i * 2] !== start[i * 2] || cg[i * 2 + 1] !== start[i * 2 + 1]) changed.add(i);
    for (let k = 0; k < 128; k++) if (oam[k * 4 + 1] < 0xe0) spritePals.add(8 + ((oam[k * 4 + 3] >> 1) & 7));
  }
  return { gaps: at.slice(1).map((f, k) => f - at[k]), l2: w.slice(0x14000, 0x16000), changed, cgram: cg.slice(), spritePals };
}
// every submap's colors (both sets) told apart, so that any color the game copies shows as a change
const distinctColors = (rom: Rom) => {
  const pal = new Uint8Array(SUBMAP_PALETTE_SIZE);
  for (let i = 0; i < 256; i++) { const v = (i * 97 + 3) & 0x7fff; pal[i * 2] = v & 0xff; pal[i * 2 + 1] = v >> 8; }
  for (const special of [false, true]) for (let m = 0; m < MAP_NAMES.length; m++) setSubmapPalette(rom, m, special, pal);
  return rom;
};
const colorAt = (cg: Uint8Array, i: number) => cg[i * 2] | (cg[i * 2 + 1] << 8);
// Yoshi's Island 1's event (on its submap) and Donut Plains 1's (on the main map)
for (const tl of [0x29, 0x15]) {
  const at = `translevel ${hx(tl)} (tile ${hx(tileOf(tl))})`;
  const fade = reveal(distinctColors(fresh()), tl);
  const rom = distinctColors(with_('pathFade', false));
  const off = reveal(rom, tl);
  setRevealSpeed(rom, MAX_REVEAL_SPEED);
  const fast = reveal(rom, tl);
  const steps = (r: { gaps: number[] }) => r.gaps.join(',');
  check(fade.gaps.length > 2 && off.gaps.length === fade.gaps.length && fast.gaps.length === fade.gaps.length,
    `${at}: the same steps with and without the fade (${fade.gaps.length + 1})`);
  const want = (r: Rom) => revealStepFrames(r);
  check(fade.gaps.every((g) => g === want(fresh())), `${at}: with the fade a step every ${want(fresh())} frames (${steps(fade)})`);
  check(off.gaps.every((g) => g === Math.ceil(0x40 / DEFAULT_REVEAL_SPEED) + 2) && fast.gaps.every((g) => g === want(rom)),
    `${at}: without the fade a step every $40 / speed frames + 2: speed ${DEFAULT_REVEAL_SPEED}: ${steps(off)}; ${hx(MAX_REVEAL_SPEED)}: ${steps(fast)}`);
  check(same(fade.l2, off.l2) && same(fade.l2, fast.l2), `${at}: the same layer 2 after the event`);
  // the colors the fade rewrites: those that change with it and not without it (the palette animations change either way)
  const byFade = [...fade.changed].filter((i) => !off.changed.has(i)).sort((a, b) => a - b);
  const names = (is: Iterable<number>) => [...is].map((i) => hx(i).padStart(2, '0')).join(' ');
  check(same(byFade, [...PATH_FADE_COLORS].sort((a, b) => a - b)) && [...off.changed].every((i) => !PATH_FADE_COLORS.has(i)),
    `${at}: the fade rewrites PATH_FADE_COLORS, without it none of them changes (${names(byFade)})`);
  const pals = (ps: Set<number>) => [...ps].sort((a, b) => a - b).map(hx).join(' ');
  const pal = (p: number, c: number) => colorAt(fade.cgram, p * 16 + c);
  check([0xc, 0xd, 0xe, 0xf].every((p) => [0, 1, 2, 3, 4, 5, 6, 7].every((c) => pal(p, c) === pal(p - 8, c)))
    && [0xc, 0xd, 0xe].every((p) => [8, 9, 10, 11, 12, 13, 14, 15].every((c) => pal(p, c) === 0)),
  `${at}: palettes C–F took colors 0–7 of palettes 4–7, colors 8–F of palettes C–E are black`);
  check([...fade.spritePals].some((p) => p >= 0xc) && [...off.spritePals].every((p) => p < 0xc),
    `${at}: sprites in palettes C–F with the fade (${pals(fade.spritePals)}), none without (${pals(off.spritePals)})`);
}
{
  const rom = fresh();
  check(pathFadeColors(rom) === PATH_FADE_COLORS && pathFadeColors(with_('pathFade', false)).size === 0, 'pathFadeColors: with the fade on only');
}
{
  const tl = 0x29;
  const rom = with_('pathFade', false);
  check(revealSpeed(fresh()) === null && revealSpeed(rom) === DEFAULT_REVEAL_SPEED, `reveal speed: none with the fade, ${DEFAULT_REVEAL_SPEED} (Lunar Magic's) without`);
  // the sprites' translucency: off with the fade off, a switch of its own then; the fade's state doesn't depend on it
  const translucent = (r: Rom) => {
    const p = PlaySession.overworld(new LevelEmulator(r), tileOf(tl));
    for (let f = 0; f < 5; f++) p.frame();
    return (p.wram[RAM.colorMath] & 0x10) !== 0;
  };
  check(owOptionValue(rom, 'translucency') === false && translucent(fresh()) && !translucent(rom), 'the fade off: sprites in palettes C–F not translucent (emulated)');
  setOwOption(rom, 'translucency', true);
  check(owOptionValue(rom, 'pathFade') === false && translucent(rom), 'translucency turned back on with the fade off (as Lunar Magic allows)');
  setOwOption(rom, 'pathFade', true);
  check(owOptionValue(rom, 'pathFade') === true && owOptionValue(rom, 'translucency') === true, 'the fade on again: translucent as in the game');
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
// a 2-player game, Mario's last life lost in Yoshi's Island 1 (the timer run out), Luigi with lives: after the game
// over, back on the overworld, the highest value of the life exchange window's counter and whose turn it is then
function gameOver(rom: Rom): { max: number; player: number } {
  const p = PlaySession.overworld(new LevelEmulator(rom), tileOf(0x29));
  const w = p.wram;
  w[RAM.twoPlayers] = 1; w[RAM.playerLives] = 4; w[RAM.playerLives + 1] = 4;
  if (!p.enter()) throw new Error('not entered');
  w[RAM.lives] = 0;
  if (p.play(400, 0, (f) => { if (f === 10) w.set([0, 0, 1], RAM.timer); }) !== 'died') throw new Error('not died');
  let max = 0, over = false;
  for (let f = 0; f < 1500; f++) {
    p.frame();
    if (w[RAM.gameMode] !== GM.overworld) continue;
    over = true;
    max = Math.max(max, w[RAM.lifeExchange]);
  }
  if (!over || w[RAM.playerLives] !== 0xff) throw new Error('no game over on the overworld');
  return { max, player: w[RAM.playerIndex] };
}
{
  const game = gameOver(fresh()), noLR = gameOver(with_('lrExchange', false)), no = gameOver(with_('lifeExchange', false));
  check(game.max > 1 && game.player === 0, `a game over offers the life exchange (${game.max})`);
  check(noLR.max > 1 && noLR.player === 0, `L/R off: a game over still offers it (${noLR.max})`);
  check(no.max <= 1 && no.player === 1, `life exchange off: a game over doesn't offer it, Luigi's turn (${no.max})`);
}

// ---- the game's lightning per submap ----
// color 47: the game's mask at $04F709, the bytes Lunar Magic 3.71 writes (ROMs it saved: F7 the game's, FF with the
// Valley of Bowser's off, 7F with only the main map's on, 77 with both, 75 with Star Road's too); each switch one ROM
// edit that undo takes back and redo brings again
{
  const rom = fresh(), s = new RomEditSession(rom), was = rom.data.slice();
  const flashes = (m: number) => {
    const emu = new OverworldEmulator(rom), c = new Set<number>();
    emu.load(m, 0);
    const C = 0x47 * 2; // color 4·7 in CGRAM
    for (let f = 0; f < 900; f++) { emu.snes.runFrame(); c.add(emu.snes.cgram[C] | (emu.snes.cgram[C + 1] << 8)); }
    return c.size;
  };
  const mask = () => rom.r8(LIGHTNING_MASK);
  const set = (m: number, on: boolean) => s.edit(lightningEditLabel(MAP_NAMES[m], on), () => setSubmapLightning(rom, m, on));
  check(mask() === 0xf7 && clean.r8(LIGHTNING_MASK) === 0xf7 && MAP_NAMES.every((_, m) => submapLightning(rom, m) === (m === 4)),
    'lightning: on the Valley of Bowser only, as in the game (F7)');
  const before = flashes(4);
  set(4, false);
  const after = flashes(4);
  check(mask() === 0xff && !submapLightning(rom, 4), `lightning: the Valley of Bowser's off: FF (${hx(mask())})`);
  check(before > 1 && after === 1, `lightning: color 47 flashes on the Valley of Bowser (${before} colors in 900 frames), turned off not (${after})`);
  const main0 = flashes(0);
  set(0, true);
  check(mask() === 0x7f, `lightning: only the main map's on: 7F (${hx(mask())})`);
  set(4, true);
  check(mask() === 0x77, `lightning: the main map's on too: 77 (${hx(mask())})`);
  set(6, true);
  check(mask() === 0x75, `lightning: and Star Road's: 75 (${hx(mask())})`);
  set(6, false);
  const main1 = flashes(0);
  check(main0 === 1 && main1 > 1, `lightning: color 47 stands still on the main map (${main0}), turned on it flashes (${main1} colors)`);
  s.undo();
  check(mask() === 0x75, `lightning: undo brings Star Road's back (${hx(mask())})`);
  s.redo();
  check(mask() === 0x77, `lightning: redo takes it again (${hx(mask())})`);
  for (let k = 0; k < 5; k++) s.undo();
  check(same(rom.data, was), 'lightning: all undone, the game\'s F7 again');
  let threw = false;
  try { setSubmapLightning(rom, 7, true); } catch { threw = true; }
  check(threw && mask() === 0xf7, 'lightning: no submap 7');
  // a patch's code there: unknown, not written
  rom.w8(LIGHTNING_MASK - 1, 0xad);
  threw = false;
  try { setSubmapLightning(rom, 4, false); } catch { threw = true; }
  check(submapLightning(rom, 4) === null && threw && mask() === 0xf7, 'lightning: changed by a patch: unknown, not written');
}

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('overworld options ok');
