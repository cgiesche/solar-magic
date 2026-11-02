// Music per submap (issue #84, core/music.ts): each submap's song ($048D8A, read when the overworld loads, and $04DBC8,
// read when Mario comes from another submap; with AddmusicK $04DBC8 alone) is set in both tables at once – the game
// plays it on that submap, both when the overworld loads there and when Mario walks there (emulated). Inserting
// AddmusicK gives the choices its numbers (as it does with the original table, also for a changed one), the tables
// stay out of AddmusicK's bytes (a song chosen later is no change of its code), inserting again keeps them, and
// removing AddmusicK gives them the original numbers back (a removed custom song: the submap's own song).
// Listening (issue #241): the editor's music player loads the overworld on a submap with the sound unit emulated
// (LevelEmulator.loadOverworldOn) – the submap's song sounds, without AddmusicK from the overworld's sound bank.
// node tools/testowmusic.ts
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { l1Index, MAP_NAMES } from '../src/core/overworld.ts';
import { RAM, GM, PAD } from '../src/core/ram.ts';
import { Apu, loadApu } from '../src/core/apu.ts';
import {
  emptyMusicProject, songsFromZip, addSongs, removeSong, saveMusicProject, musicEntry, hasAmk, romSongs,
  submapMusic, setSubmapMusic, submapSongs, defaultSubmapMusic, submapsWithSong, SUBMAP_MUSIC, SUBMAP_MUSIC_SWITCH, SUBMAPS,
} from '../src/core/music.ts';
import { AMK_SUBMAP_SONGS } from '../src/vendor/amk/originals.ts';
import { testSongZip } from './testsong.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
const songs = (rom: Rom) => Array.from({ length: SUBMAPS }, (_, i) => submapMusic(rom, i));
const table = (rom: Rom, t: number) => Array.from({ length: SUBMAPS }, (_, i) => rom.r8(t + i));
const list = (a: number[]) => a.map(hx).join(' ');

// The song the game plays on each submap: the last one written to $1DFB (the original driver: the request port) or
// AddmusicK's current song, after the overworld loaded there (load) and after Mario walked from the main map onto
// Yoshi's Island (walk: main map 02,14, whose path leads there)
function played(rom: Rom): { load: number[]; walk: number } {
  const emu = new LevelEmulator(rom), s = emu.snes, w = s.wram, cpu = s.cpu, amk = hasAmk(rom);
  let last = 0;
  const exec = cpu.exec.bind(cpu);
  cpu.exec = (op: number) => { exec(op); if (w[RAM.musicRequest]) last = w[RAM.musicRequest]; };
  const song = () => (amk ? w[RAM.amkSong] : last);
  emu.startGameAt(-1);
  const ow = s.saveState(), load: number[] = [];
  for (let k = 0; k < SUBMAPS; k++) {
    s.loadState(ow);
    last = 0;
    w[RAM.submap] = w[RAM.submap + 1] = k;
    w[RAM.gameMode] = GM.overworldLoad;
    for (let f = 0; w[RAM.gameMode] !== GM.overworld && f < 500; f++) s.runFrame();
    for (let f = 0; f < 30; f++) s.runFrame();
    load.push(song());
  }
  const i = l1Index(0, 2, 0x13);
  emu.startGameAt(i);
  w[RAM.owTranslevels + i] = 1; w[RAM.levelFlags + 1] = 0x0f; w[RAM.submap] = w[RAM.submap + 1] = 0;
  last = 0;
  let walked = false;
  for (let f = 0; f < 900; f++) {
    s.joy1 = f < 4 ? PAD.down : 0;
    s.runFrame();
    if (w[RAM.owProcess] !== 3) walked = true;
    else if (walked && f > 30) break;
  }
  for (let f = 0; f < 30; f++) s.runFrame();
  cpu.exec = exec;
  return { load, walk: w[RAM.submap] === 1 ? song() : -1 };
}

// What the music player plays for submap `map`: the song the game asked for (as played) and the sound's peak once it
// runs; bank: without AddmusicK, whether the sound unit holds the original overworld sound bank ($0E98B1: blocks of
// length, ARAM address, data), not the levels' ($0EAED6)
function heard(rom: Rom, map: number): { song: number; peak: number; owBank: boolean } {
  const emu = new LevelEmulator(rom), s = emu.snes, w = s.wram, cpu = s.cpu, amk = hasAmk(rom);
  s.apu = new Apu();
  let last = 0;
  const exec = cpu.exec.bind(cpu);
  cpu.exec = (op: number) => { exec(op); if (w[RAM.musicRequest]) last = w[RAM.musicRequest]; };
  emu.loadOverworldOn(map);
  let peak = 0;
  for (let f = 0; f < 120; f++) { s.runFrame(); for (const v of s.audio!) peak = Math.max(peak, Math.abs(v)); }
  cpu.exec = exec;
  const ram = s.apu.ram();
  let owBank = rom.r16(0x0e98b1) > 0;
  for (let a = 0x0e98b1, len; (len = rom.r16(a)); a += 4 + len) {
    const dst = rom.r16(a + 2), src = snesToPc(a + 4);
    if (!ram.subarray(dst, dst + len).every((v, i) => v === rom.data[src + i])) owBank = false;
  }
  return { song: amk ? w[RAM.amkSong] : last, peak, owBank };
}
const listened = (rom: Rom, want: number[], what: string) => {
  for (const k of [0, 1, 5]) {
    const h = heard(rom, k);
    check(h.song === want[k] && h.peak > 1000 && (hasAmk(rom) || h.owBank),
      `${what}: listening to ${MAP_NAMES[k]} plays its song ${hx(h.song)} (want ${hx(want[k])}, peak ${h.peak}${hasAmk(rom) ? '' : `, overworld sound bank ${h.owBank}`})`);
  }
};

await loadApu();
const rom = new Rom(await editorImage());
const original = songs(rom);
check(list(original) === list(AMK_SUBMAP_SONGS.original) && list(table(rom, SUBMAP_MUSIC_SWITCH)) === list(original),
  `the clean game's submap songs in both tables, as AddmusicK knows them (${list(original)})`);
{
  const p = played(rom);
  check(list(p.load) === list(original) && p.walk === original[1], `the game plays them: loaded on each submap ${list(p.load)}, walked onto Yoshi's Island ${hx(p.walk)}`);
}
const choices = submapSongs(rom);
check(choices.length === SUBMAPS && choices.every((s) => original.includes(s.num)) && choices.find((s) => s.num === original[1])?.name === "Yoshi's Island",
  `without AddmusicK the original submap songs to choose from (${choices.map((s) => `${hx(s.num)} ${s.name}`).join(', ')})`);

// ---- each submap set to another song ----
const rotated = original.map((_, i) => original[(i + 1) % SUBMAPS]);
const before = rom.data.slice();
setSubmapMusic(rom, 1, rotated[1]);
let changed = 0;
for (let i = 0; i < rom.data.length; i++) if (rom.data[i] !== before[i]) changed++;
check(changed === 2 && submapMusic(rom, 1) === rotated[1] && rom.r8(SUBMAP_MUSIC_SWITCH + 1) === rotated[1], `one song set: one byte in each table (${changed} bytes changed)`);
for (let i = 0; i < SUBMAPS; i++) setSubmapMusic(rom, i, rotated[i]);
{
  const p = played(rom);
  check(list(p.load) === list(rotated), `every submap set to another song: the game plays it when the overworld loads there (${list(p.load)}, set ${list(rotated)})`);
  check(p.walk === rotated[1], `walked onto Yoshi's Island: its song (${hx(p.walk)})`);
}
listened(rom, rotated, 'every submap set to another song');

// ---- AddmusicK inserted: the choices under its numbers ----
const proj = emptyMusicProject();
const [custom] = addSongs(proj, songsFromZip('Square Test.zip', testSongZip()));
const mapped = rotated.map((s) => AMK_SUBMAP_SONGS.amk[AMK_SUBMAP_SONGS.original.indexOf(s)]);
const r = await saveMusicProject(rom, proj);
check(r.ok && hasAmk(rom), `AddmusicK inserted ${r.errors.join(' ')}`);
check(list(songs(rom)) === list(mapped) && list(table(rom, SUBMAP_MUSIC_SWITCH)) === list(mapped), `the choices kept under AddmusicK's numbers (${list(songs(rom))}, want ${list(mapped)})`);
const segs = musicEntry(rom)!.segs;
const inSegs = (snes: number) => segs.some(([pc, n]) => { const o = snesToPc(snes); return o >= pc && o < pc + n; });
check([SUBMAP_MUSIC, SUBMAP_MUSIC_SWITCH].every((t) => Array.from({ length: SUBMAPS }, (_, i) => t + i).every((a) => !inSegs(a))), 'the tables are not part of AddmusicK\'s bytes');
check(submapSongs(rom, proj).length === romSongs(rom, proj).length && submapSongs(rom, proj).some((s) => s.num === custom.num), 'with AddmusicK every song of the ROM to choose from, the custom one too');
{
  const p = played(rom);
  check(list(p.load) === list(mapped) && p.walk === mapped[1], `AddmusicK plays them: loaded ${list(p.load)}, walked onto Yoshi's Island ${hx(p.walk)}`);
}
listened(rom, mapped, 'AddmusicK');

// ---- a custom song for Yoshi's Island; inserting again (as a package does) keeps it ----
setSubmapMusic(rom, 1, custom.num);
check(submapsWithSong(rom, custom.num).join() === '1', 'Yoshi\'s Island set to the custom song');
const [second] = addSongs(proj, songsFromZip('Second.zip', testSongZip(), new Set(['square test'])));
const r2 = await saveMusicProject(rom, proj);
check(r2.ok && !r2.warnings.some((x) => x.includes('modified')), `another song inserted, no warning about AddmusicK's bytes changed (${[...r2.errors, ...r2.warnings].join(' ')})`);
check(submapMusic(rom, 1) === custom.num && list(songs(rom).filter((_, i) => i !== 1)) === list(mapped.filter((_, i) => i !== 1)), `the choices kept (${list(songs(rom))})`);
{
  const p = played(rom);
  check(p.load[1] === custom.num && p.walk === custom.num, `Yoshi's Island plays the custom song: loaded ${hx(p.load[1])}, walked onto ${hx(p.walk)}`);
}

// ---- AddmusicK removed: the original numbers back, the custom song's submap its own song ----
removeSong(proj, custom.num);
removeSong(proj, second.num);
const r3 = await saveMusicProject(rom, proj);
check(r3.ok && !hasAmk(rom), `AddmusicK removed ${r3.errors.join(' ')}`);
const back = rotated.map((s, i) => (i === 1 ? defaultSubmapMusic(rom, 1) : s));
check(list(songs(rom)) === list(back) && list(table(rom, SUBMAP_MUSIC_SWITCH)) === list(back), `the original numbers back, Yoshi's Island its own song (${list(songs(rom))}, want ${list(back)})`);
check(defaultSubmapMusic(rom, 1) === original[1], `${MAP_NAMES[1]}'s own song: ${hx(defaultSubmapMusic(rom, 1))}`);

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all ok');
