// The game's screens that belong to no level, reached by emulation (pregame.ts): Nintendo Presents, the title
// screen, file select, file erase, player select, the save prompt and the game over prompt – each the game's own
// picture, its menu text the game's stripe image with the cursor where the game puts it (the clean game's addresses,
// here only to check); a screen the game no longer gets into is not listed; the way to a screen run again, watched;
// the screens kept while what the game read holds.
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { GM } from '../src/core/ram.ts';
import { GAME_SCREENS, reachScreens, gameScreens, replayScreen, screenPicture, type GameScreenId, type ReachedScreen } from '../src/core/pregame.ts';
import { titlePicture } from '../src/core/titlescreen.ts';
import { editorImage, cleanImage } from './fixture.ts';
import { writePng } from './png.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const vramWord = (v: Uint8Array, a: number) => v[a * 2] | (v[a * 2 + 1] << 8);
const out = process.env.OUT;

// the words a stripe image writes (VRAM address → word), walked from its SNES address to its end
function stripeWords(rom: Rom, snes: number): Map<number, number> {
  const d = rom.data, words = new Map<number, number>();
  for (let o = snesToPc(snes); !(d[o] & 0x80);) {
    const addr = (d[o] << 8) | d[o + 1], down = !!(d[o + 2] & 0x80), rle = !!(d[o + 2] & 0x40), len = (((d[o + 2] & 0x3f) << 8) | d[o + 3]) + 1;
    for (let i = 0; i < len / 2; i++) words.set(addr + i * (down ? 32 : 1), d[o + 4 + (rle ? 0 : i * 2)] | (d[o + 5 + (rle ? 0 : i * 2)] << 8));
    o += 4 + (rle ? 2 : len);
  }
  return words;
}
const CURSOR = 0x3d2e;
// the clean game's menus: mode, stripe image, the cursor's first position
const MENUS: [GameScreenId, number, number, number][] = [
  ['fileSelect', GM.fileSelect, 0x05b7c9, 0x51e8],
  ['fileErase', GM.fileErase, 0x05b6fe, 0x51e5],
  ['playerSelect', GM.playerSelect, 0x05b872, 0x5208],
  ['savePrompt', GM.overworld, 0x05b8c7, 0x51c4],
  ['gameOverPrompt', GM.overworld, 0x05b91c, 0x51cb],
];

// the game's screens
{
  const rom = fresh(), emu = new LevelEmulator(rom), t = Date.now(), screens = reachScreens(emu), ms = Date.now() - t;
  const by = new Map(screens.map((s) => [s.id, s]));
  check(same(screens.map((s) => GAME_SCREENS.findIndex((k) => k.id === s.id)), GAME_SCREENS.map((_, i) => i)), `every screen reached, in the game's order (${screens.map((s) => s.id).join(', ')}; ${ms} ms)`);
  const pics = new Map(screens.map((s) => [s.id, screenPicture(emu, s.state)]));
  if (out) for (const [id, p] of pics) writePng(`${out}/pregame-${id}.png`, 256, 224, p.frame);
  check(screens.every((s) => { const f = pics.get(s.id)!.frame; return new Set(f).size > 1; }), 'each with a picture');
  check(new Set([...pics.values()].map((p) => p.frame.join())).size === screens.length, 'each another picture');
  check(same(pics.get('title')!.frame, titlePicture(emu).frame), 'the title screen: the picture its editor shows');

  // Nintendo Presents: the logo's four sprites
  const pr = by.get('presents')!;
  check(pr.mode === GM.presents && by.get('title')!.mode === GM.title, 'Nintendo Presents in game mode 01, the title screen in 07');
  const oam = pr.state.oam as Uint8Array;
  check(same([0, 1, 2, 3].map((i) => oam[i * 4 + 2]), [0x02, 0x04, 0x06, 0x08]) && [0, 1, 2, 3].every((i) => oam[i * 4 + 1] === 0x70), 'Nintendo Presents: the logo\'s four sprites');

  for (const [id, mode, stripe, cursor] of MENUS) {
    const s = by.get(id);
    if (!s) { check(false, `${id} reached`); continue; }
    const v = s.state.vram as Uint8Array, words = [...stripeWords(rom, stripe)];
    const shown = words.filter(([a, w]) => vramWord(v, a) === w).length;
    // (the game writes over some: the exit counts, EMPTY, the cursor's column)
    check(s.mode === mode && shown > words.length * 0.8, `${id}: game mode ${mode.toString(16)}, its stripe image on layer 3 (${shown} of ${words.length} tiles)`);
    check(vramWord(v, cursor) === CURSOR && vramWord(pics.get(id)!.vram, cursor) === CURSOR, `${id}: the cursor shown, at its first choice, in the picture too`);
    check(vramWord(by.get('title')!.state.vram as Uint8Array, cursor) !== CURSOR, `${id}: no cursor there on the title screen`);
  }

  // the way to a screen run again: the same machine, the ROM read on the way seen
  {
    const s = by.get('fileSelect')!, read = new Set<number>();
    replayScreen(emu, s, { onRomRead: (o) => { read.add(o); } });
    check(same(emu.snes.vram, s.state.vram as Uint8Array) && same(emu.snes.wram, s.state.wram as Uint8Array), 'the way to the file select run again: the same machine');
    const at = snesToPc(0x05b7c9);
    check(read.has(at) && read.has(at + 168) && !read.has(snesToPc(0x05b8c7)), 'watched: the game reads the file select\'s stripe image, not the save prompt\'s');
    replayScreen(emu, by.get('title')!);
    check(same(emu.snes.vram, by.get('title')!.state.vram as Uint8Array), 'the title screen again: the boot');
  }
  check(emu.snes.hook === null && emu.snes.joy1 === 0, 'the emulator left without a hook or a button held');
  emu.load(0x105);
  check(emu.snes.wram[0x100] !== GM.fileSelect, 'a level loads after it (from the boot)');
}

// kept while what the game read to get there holds
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  const a = gameScreens(emu);
  check(gameScreens(emu) === a, 'kept: asked again, the same');
  const text = snesToPc(0x05b7c9) + 4, free = rom.data.length - 0x100;
  rom.writeAt(free, Uint8Array.from([rom.data[free] ^ 0xff]));
  check(gameScreens(emu) === a, 'kept over an edit of a byte the game did not read');
  rom.writeAt(text, Uint8Array.from([0x0a])); // the first tile of the file select's text
  const b = gameScreens(emu), fs = b.find((s) => s.id === 'fileSelect') as ReachedScreen;
  check(b !== a && b.length === a.length, 'reached anew after an edit of the file select\'s stripe image');
  check((vramWord(fs.state.vram as Uint8Array, (rom.data[text - 4] << 8) | rom.data[text - 3]) & 0xff) === 0x0a, 'the file select shows the edit');
}

// a screen the game doesn't get into is not listed: the file select's fourth choice made a file like the others
// (INC $0100 : CPX #$03 : BNE → BRA)
{
  const rom = fresh(), d = rom.data, pat = [0xee, 0x00, 0x01, 0xe0, 0x03, 0xd0];
  let at = -1;
  for (let o = snesToPc(0x009000); o < snesToPc(0x00a000) && at < 0; o++) if (pat.every((b, i) => d[o + i] === b)) at = o;
  rom.writeAt(at + 5, Uint8Array.from([0x80]));
  const ids = reachScreens(new LevelEmulator(rom)).map((s) => s.id);
  check(at >= 0 && !ids.includes('fileErase') && ids.length === GAME_SCREENS.length - 1, `no file erase in a game whose file select doesn't lead there (${ids.join(', ')})`);
}

// the save prompt where a new game's Mario can walk nowhere (as in most hacks: no path open before the first level is
// passed) – the clean game with no direction enabled in a new file's level flags ($009EE0: 8 pairs)
{
  const raw = cleanImage(), rom = new Rom(raw.slice(raw.length % 0x8000)), o = snesToPc(0x009ee0);
  const flags = rom.data.slice(o, o + 16);
  for (let i = 1; i < 16; i += 2) flags[i] &= 0xf0;
  rom.writeAt(o, flags);
  const s = reachScreens(new LevelEmulator(rom)).find((x) => x.id === 'savePrompt');
  check(!!s && vramWord(s.state.vram as Uint8Array, 0x51c4) === CURSOR, 'the save prompt in a game whose start has no path open');
}

// a game that doesn't reach its title screen: no screens after Nintendo Presents, no error
{
  const rom = fresh();
  rom.writeAt(snesToPc(0x009329), Uint8Array.from([0x80, 0xfe])); // (the game mode's run: an endless loop)
  let ids: string[] | null = null;
  try { ids = reachScreens(new LevelEmulator(rom)).map((s) => s.id); } catch (e) { console.log(`  (${e})`); }
  check(!!ids && !ids.includes('title') && !ids.includes('fileSelect'), `a game that hangs: no title screen, no menus (${ids?.join(', ')})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
