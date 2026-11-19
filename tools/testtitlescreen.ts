// The title screen's layer 3 tilemap (titlescreen.ts): read as the game shows it, written in Lunar Magic's
// layout (one stripe image of 32 × 29 tiles at VRAM $5000, ended by $80, in a RATS block that the stripe image
// table's entry 03 points to), the game then showing it; the picture of the title screen as the game draws it.
import { existsSync, readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { TITLE_COLS, TITLE_ROWS, TITLE_STRIPE_PTR, titleTilemap, titleStripe, writeTitleScreen, titlePicture, titleStripeAddr } from '../src/core/titlescreen.ts';
import { titleMovement, runState } from '../src/core/titlemovement.ts';
import { gameScreens, reachedScreenIds } from '../src/core/pregame.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const N = TITLE_COLS * TITLE_ROWS;
// VRAM words of the title screen's layer 3 tilemap, rows 0-28 of its first 32 columns
const vramRows = (v: Uint8Array) => Uint16Array.from({ length: N }, (_, i) => { const a = (0x5000 + i) * 2; return v[a] | (v[a + 1] << 8); });
const booted = (rom: Rom) => { const e = new LevelEmulator(rom); e.boot(); return e; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

// the game's title screen
{
  const rom = fresh(), map = titleTilemap(booted(rom));
  check(map.length === N, `32 × 29 tiles (${map.length})`);
  check(map[0] === 0x2c58 && map[1] === 0x2c59, 'its first row: the frame\'s tiles');
  check(titleStripeAddr(rom) === 0x05b375, 'the game\'s stripe image at $05B375');
}

// Lunar Magic's layout of the stripe
{
  const map = Uint16Array.from({ length: N }, (_, i) => (i * 7 + 0x100) & 0xffff), s = titleStripe(map);
  check(same(s.subarray(0, 4), [0x50, 0x00, 0x07, 0x3f]), 'header: VRAM $5000, 0x740 bytes, not RLE');
  check(s.length === 4 + 0x740 + 1 && s[s.length - 1] === 0x80, 'one stripe, ended by $80');
  check(s[4] === (map[0] & 0xff) && s[5] === map[0] >> 8 && s[4 + 2 * (N - 1)] === (map[N - 1] & 0xff), 'the words low byte first');
}

// written: the game shows it, reads it back; written again: the old block freed
{
  const rom = fresh();
  const map = Uint16Array.from({ length: N }, (_, i) => 0x3800 | ((i * 13) & 0xff));
  writeTitleScreen(rom, map);
  const at = titleStripeAddr(rom), off = snesToPc(at);
  check(rom.isRatsAt(off - 8) === 0x745, `a RATS block of 0x745 bytes (${rom.isRatsAt(off - 8).toString(16)})`);
  check(same(rom.data.subarray(off, off + 0x745), titleStripe(map)), 'holding the stripe');
  check(rom.data[snesToPc(TITLE_STRIPE_PTR)] === (at & 0xff), 'pointed to by $0084D3');
  const e = booted(rom);
  check(same(vramRows(e.snes.vram), map), 'the game draws it on the title screen');
  check(same(titleTilemap(e), map), 'read back');
  const map2 = map.map((w) => w ^ 0x4000), blocks = rom.scanRats().length;
  writeTitleScreen(rom, map2);
  check(rom.scanRats().length === blocks, 'written again: the first block freed');
  check(same(titleTilemap(booted(rom)), map2), 'written again: the new tilemap');
}

// painted: no dependency of what is learned from a level (#550). The boot runs to the title screen and reads the
// picture, and every result starts from the boot: its reads leave the picture out, the snapshot is booted again, the
// title screen's own results (record 'title screen') depend on it. A level loaded shows nothing of it.
{
  const rom = fresh(), e = booted(rom);
  const load = () => { const r = e.load(0x105); return { vram: r.vram.slice(), cgram: r.cgram.slice() }; };
  const unpainted = load();
  // (painted: every cell with another palette; first the game's picture, which moves to a block of the editor's, then that one)
  for (const [what, edit] of [['the game\'s picture painted', 0x0400], ['the editor\'s picture painted', 0x0800]] as const) {
    const bootReads = e.snapshot!.reads, titleReads = e.record('title screen', () => 0).reads, before = rom.data.slice();
    const map = titleTilemap(e).map((w) => w ^ edit);
    writeTitleScreen(rom, map);
    check(!bootReads.differ(before, rom.data), `${what}: nothing the boot's reads hold changed`);
    check(titleReads.differ(before, rom.data), `${what}: a result that shows the title screen no longer holds`);
    check(same(titleTilemap(e), map), `${what}: the boot snapshot is booted again, the title screen shows it`);
    const painted = load();
    check(same(painted.vram, unpainted.vram) && same(painted.cgram, unpainted.cgram), `${what}: level 105 loads to the same VRAM and CGRAM`);
  }
}

// the picture: the game's own tilemap written back looks the same; another tile changes its 8x8 pixels only
{
  const rom = fresh(), e = booted(rom), map = titleTilemap(e), before = titlePicture(e);
  check(before.frame.some((p) => p !== before.frame[0]), 'a picture of the title screen');
  writeTitleScreen(rom, map);
  const after = titlePicture(booted(rom));
  check(same(after.frame, before.frame), 'the game\'s tilemap written back: the same picture');
  const edited = map.slice();
  edited[10 * 32 + 3] = 0x38fc; // a part of the logo: an empty tile
  const p = titlePicture(e, edited);
  let changed = 0, outside = 0;
  for (let i = 0; i < p.frame.length; i++) {
    if (p.frame[i] === before.frame[i]) continue;
    changed++;
    const x = i % 256, y = Math.floor(i / 256);
    if (x >> 3 !== 3 || y >> 3 !== 10) outside++;
  }
  check(changed > 0 && !outside, `an edit before saving: its tile's pixels only (${changed}, ${outside} elsewhere)`);
  check(same(titleTilemap(e), map), 'the emulator\'s title screen unchanged by it');
}

// the same for a boot inside a recording (the editor's level load boots there): the load's result holds too – the
// picture's entry is on a page of code every load runs, read by byte (romdeps.ts)
{
  const rom = fresh(), e = new LevelEmulator(rom);
  const first = e.record('picture', () => e.load(0x105)).reads, before = rom.data.slice();
  writeTitleScreen(rom, titleTilemap(e).map((w) => w ^ 0x0400));
  check(!e.snapshot!.reads.differ(before, rom.data) && !first.differ(before, rom.data), 'booted inside a level\'s load: the boot\'s and the load\'s reads hold after painting');
  const again = e.record('picture', () => e.load(0x105)).reads, then = rom.data.slice(); // (boots again, inside the recording)
  writeTitleScreen(rom, titleTilemap(e).map((w) => w ^ 0x0400));
  check(!e.snapshot!.reads.differ(then, rom.data) && !again.differ(then, rom.data), 'booted again inside a level\'s load: they hold after painting again');
}

// painted: what doesn't show the picture is kept (#550) – the title screen movement's run (its machines get the
// picture as booted), the screens' list, a level's picture; the screens' machines are learned again
{
  const rom = fresh(), e = new LevelEmulator(rom);
  const mv = titleMovement(e), screens = gameScreens(e), ids = reachedScreenIds(e);
  const level = e.record('full picture', () => e.load(0x105)).reads, before = rom.data.slice();
  const map = titleTilemap(e).map((w) => w ^ 0x0400);
  writeTitleScreen(rom, map);
  check(titleMovement(e) === mv, 'painted: the title screen movement\'s run is kept');
  check(same(vramRows(runState(e, mv.run!, 700).vram as Uint8Array), map), 'painted: the run\'s machine at frame 700 has the picture as painted');
  check(!level.differ(before, rom.data), 'painted: a level\'s picture (a full picture) holds');
  check(reachedScreenIds(e) === ids, 'painted: the screens\' list is kept');
  const again = gameScreens(e);
  check(again !== screens && again.map((x) => x.id).join() === screens.map((x) => x.id).join(), 'painted: the screens\' machines are learned again, the same screens');
}

// a ROM Lunar Magic saved: its title screen's first stripe is the editor's layout (header, 32 × 29 tiles), the
// game shows it, the editor reads it (Journey to Kaizo: a second stripe at $5400, the right screen, not shown)
const LM = 'resources_local/Journey to Kaizo v1.1 (LM rom).smc';
if (existsSync(LM)) {
  const raw = readFileSync(LM), lm = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
  const off = snesToPc(titleStripeAddr(lm)), stripe = lm.data.subarray(off, off + 4 + 0x740);
  check(same(stripe.subarray(0, 4), [0x50, 0x00, 0x07, 0x3f]) && lm.isRatsAt(off - 8) > 0, 'Lunar Magic: one stripe at $5000 of 0x740 bytes, in a RATS block');
  const words = Uint16Array.from({ length: N }, (_, i) => stripe[4 + i * 2] | (stripe[5 + i * 2] << 8));
  let read: Uint16Array | null = null;
  try { read = titleTilemap(booted(lm)); } catch (e) { console.log(`  (does not boot: ${e})`); }
  check(!!read && same(read, words), 'Lunar Magic: the editor reads the tiles Lunar Magic wrote');
  check(same(titleStripe(words).subarray(0, 4 + 0x740), stripe), 'Lunar Magic: the editor writes them the same way');
} else console.log('skip  Lunar Magic\'s title screen (no Journey to Kaizo ROM in resources_local)');

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
