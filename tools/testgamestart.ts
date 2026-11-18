// The start of a game (gamestart.ts): what a new save file starts with, learned by playing one – the intro level and
// the byte that chooses it, its message, whether the game saves after it, the lives and their byte, where Mario
// stands with and without the intro (the clean game's addresses, here only to check); the intro turned off and given
// another level, the lives written, as the game then starts; an intro level the game computes has no field; with
// Retry System installed the lives' byte is its patch's, set by !initial_lives.
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { learnGameStart, gameStart, writeIntroLevel, writeStartLives, introIsField, introValueFor, valueOwner, settingOf, sameSpot } from '../src/core/gamestart.ts';
import { writeStart } from '../src/core/owsprites.ts';
import { inspectUpload, installPackage, defaultAssignment } from '../src/core/packages.ts';
import { GM, RAM } from '../src/core/ram.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const base = await editorImage();
const fresh = () => new Rom(base.slice());
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
const hex = (n: number | null | undefined) => (n === null || n === undefined ? 'none' : n.toString(16));
const INTRO = snesToPc(0x009cb1), LIVES = snesToPc(0x009e25);

{
  const rom = fresh(), emu = new LevelEmulator(rom);
  emu.ensureBoot();
  const t0 = Date.now(), g = learnGameStart(emu), ms = Date.now() - t0;
  check(g.reached && g.intro.level === 0xc5, `a new file loads level C5 before its first overworld (${hex(g.intro.level)}, ${ms} ms)`);
  check(g.intro.armed?.value === 0xe9 && g.intro.armed.at === INTRO, `chosen by the byte at $009CB1, $E9 (${hex(g.intro.armed?.value)} at pc ${hex(g.intro.armed?.at)})`);
  check(introIsField(g) && g.intro.tried.some((t) => t.value === 0xe9 && t.level === 0xc5) && g.intro.tried.some((t) => t.value === 0xea && t.level === 0xc6) && g.intro.tried.some((t) => t.value === 1 && t.level === 1),
    `tried with other values: the game loads other levels (${g.intro.tried.map((t) => `${hex(t.value)}→${hex(t.level)}`).join(', ')})`);
  const vals = [0xc7, 0x12, 0x105].map((n) => introValueFor(emu, g, n));
  check(vals[0] === 0xeb && (vals[1] === 0x36 || vals[1] === 0x12) && vals[2] === null, `the value for a level: found by trying it in the game; none for a level the byte does not reach (${vals.map(hex).join(', ')})`);
  check(g.intro.message?.translevel === 0 && g.intro.message.msg === 1, 'the intro level opens translevel 0\'s message 1');
  check(!g.intro.saves, 'the game does not save after the intro');
  check(g.lives?.value === 4 && g.lives.at === LIVES, `the lives: 4 left (5 shown), read from $009E25 (${hex(g.lives?.value)} at pc ${hex(g.lives?.at)})`);
  check(!!g.spot && !!g.intro.spot && sameSpot(g.spot, g.intro.spot) && g.spot.submap === 1 && g.spot.tx === 6 && g.spot.ty === 7, `Mario stands at the start position, with the intro and without (${JSON.stringify(g.spot)})`);
  const shown = g.intro.shown as { wram: Uint8Array } | null;
  check(!!shown && shown.wram[RAM.gameMode] === GM.level && shown.wram[RAM.message] === 1 && !!g.overworld && (g.overworld as { wram: Uint8Array }).wram[RAM.gameMode] === GM.overworld, 'the machine showing the intro (its message open), and the one on the first overworld');
  check(emu.snes.hook === null && !emu.snes.taintOn && same(rom.data, base), 'the emulator left without a hook or source tracking, the ROM as it was');
  check(valueOwner(rom, g.lives) === null && valueOwner(rom, g.intro.armed) === null, 'both bytes are the game\'s own');

  // no intro: the byte's 0
  writeIntroLevel(emu, g, null);
  const off = gameStart(emu);
  check(rom.data[INTRO] === 0 && off.reached && off.intro.level === null && off.intro.armed?.at === INTRO && off.intro.armed.value === 0 && introIsField(off) && !off.intro.shown,
    'the intro turned off: the byte 0, a new file gets to the overworld without a level – the byte still known to choose it');
  check(gameStart(emu) === off, 'kept: asked again, the same');
  // another level
  writeIntroLevel(emu, off, 0xc7);
  const other = gameStart(emu);
  check(other.intro.level === 0xc7 && other.intro.armed?.value === 0xeb, `another level written: the game loads it (${hex(other.intro.level)}, byte ${hex(other.intro.armed?.value)})`);
  let no = '';
  try { writeIntroLevel(emu, other, 0x105); } catch (e) { no = String(e); }
  check(/000–0FF/.test(no) && rom.data[INTRO] === 0xeb, `a level the byte can't choose is refused with the reason (${no})`);
  check(!other.reached && !other.overworld, 'with the title screen level as the intro a new file never gets to the overworld: told');
  // the lives
  writeIntroLevel(emu, other, 0xc5);
  writeStartLives(rom, gameStart(emu), 10);
  const more = gameStart(emu);
  check(rom.data[LIVES] === 9 && more.lives?.value === 9 && (more.overworld as { wram: Uint8Array }).wram[RAM.lives] === 9, '10 lives written: a new file starts with them');
  let no3 = '';
  try { writeStartLives(rom, more, 0); } catch (e) { no3 = String(e); }
  check(!!no3, 'no lives is refused');
}

// a moved start position: the intro puts Mario elsewhere (the game's intro sets his submap and Y position) – told
{
  const rom = fresh(), emu = new LevelEmulator(rom);
  for (const p of [0, 1]) writeStart(rom, p, { submap: 0, x: 3, y: 0x12 });
  const g = gameStart(emu);
  check(!!g.spot && g.spot.submap === 0 && g.spot.tx === 3 && g.spot.ty === 0x12 && !!g.intro.spot && !sameSpot(g.spot, g.intro.spot),
    `a start position on the main map: where Mario stands after the intro is another place (${JSON.stringify(g.intro.spot)})`);
}

// an intro level the game computes (the load of the byte replaced by INC $0109: the title screen level's value + 1):
// the level it gives, no byte to choose it
{
  const rom = fresh();
  rom.writeAt(INTRO - 1, Uint8Array.from([0xee, 0x09, 0x01, 0xea, 0xea]));
  const emu = new LevelEmulator(rom), g = gameStart(emu);
  let no = '';
  try { writeIntroLevel(emu, g, 0xc5); } catch (e) { no = String(e); }
  check(g.intro.level === 0xc8 && g.intro.armed?.value === 0xec && g.intro.armed.at < 0 && !introIsField(g) && !!no,
    `an intro level the game computes: shown, no field (level ${hex(g.intro.level)}, value ${hex(g.intro.armed?.value)})`);
  check(g.lives?.at === LIVES, 'the lives stay a field');
}

// assembly sources: the define a byte is written from
{
  const enc = new TextEncoder(), files = new Map([
    ['a/hex.asm', enc.encode('pushpc\n; lives\norg $009E25\n    db !some_lives-1\npullpc\n')],
    ['a/settings.asm', enc.encode('; settings\n    !some_lives = 7\n')],
  ]);
  const s = settingOf(files, 0x809e25);
  check(s?.define === 'some_lives' && s.file === 'a/settings.asm' && s.from === 'a/hex.asm' && settingOf(files, 0x009e26) === null, 'the define a byte is written from, and the file that sets it');
}

// Retry System (Kevin): the lives' byte is written by its code, from !initial_lives
{
  await loadAsar();
  const rom = fresh();
  const retry = inspectUpload('retry-system_v2.2.0.zip', new Uint8Array(readFileSync('test/fixtures/retry-system_v2.2.0.zip')));
  if (retry.status !== 'manual') throw new Error('Retry: no manual preview');
  const r = await installPackage(rom, retry, { level: 0x105, blank: [0, 0, 0, 0], tileWords: () => [0, 0, 0, 0], assignment: defaultAssignment(retry, 0x105) });
  const emu = new LevelEmulator(rom), g = gameStart(emu), o = valueOwner(rom, g.lives);
  check(r.ok && g.lives?.value === 98 && g.lives.at === LIVES, `Retry System installed: a new file starts with 99 lives, still a byte at $009E25 (${hex(g.lives?.value)})`);
  check(o?.setting?.define === 'initial_lives' && /settings_global\.asm$/.test(o.setting.file) && /retry/i.test(o.pkg ?? ''), `it is Retry's: !initial_lives in its settings (${JSON.stringify(o)})`);
  check(g.intro.level === 0xc5 && valueOwner(rom, g.intro.armed) === null, 'the intro stays the game\'s');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
