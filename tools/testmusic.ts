// Music: a generated song with its own BRR sample (zip laid out like a download, the sample in a
// folder other than the song's #path) is inserted with AddmusicK, levels still load the same, a level
// set to the song plays it in the game (emulated with the sound unit), AddmusicK's SPC of the song
// plays, and removing the project restores the ROM.
// node tools/testmusic.ts
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { testSongZip } from './testsong.ts';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { Apu, loadApu } from '../src/core/apu.ts';
import { setLevelMusic, levelMusic } from '../src/core/patches.ts';
import {
  emptyMusicProject, songsFromZip, addSongs, saveMusicProject, loadMusicProject, musicEntry, hasAmk, romSongs,
  songSpcs, spcOf, removeSong, folders,
} from '../src/core/music.ts';

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

const peak = (a: Int16Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

await loadApu();
const raw = readFileSync('Super Mario World (U) [!].smc');
const vanilla = new Rom(new Uint8Array(raw.subarray(raw.length % 0x8000)));
const rom = new Rom(vanilla.data.slice());

// the download
const sf = songsFromZip('Square Test.zip', testSongZip());
check(sf.songs.length === 1 && sf.songs[0].name === 'Square Test', `one song found, named by #title (${sf.songs.map((s) => s.name)})`);
check(sf.missing.length === 0 && sf.files.has('Square Test/testsong/square.brr'), `sample copied to where the song looks for it (${[...sf.files.keys()].join(', ')})`);
check(![...sf.files.keys()].some((f) => f.endsWith('readme.txt')), 'readme not taken as a file of the song');

const p = emptyMusicProject();
const [song] = addSongs(p, sf);
check(song.num === 0x29, `first custom song gets number 29 (${song.num.toString(16)})`);

// listen before inserting: AddmusicK's SPC of the song
const pre = await songSpcs(p, [song.file]);
const spc = spcOf(pre.spcs, song.file);
check(!!spc && pre.errors.length === 0, `SPC generated without a ROM (${pre.errors.join(' ')})`);
if (spc) {
  const apu = new Apu();
  check(apu.loadSpc(spc), 'SPC loads');
  const pk = peak(apu.play(32000 * 2));
  check(pk > 1000, `SPC plays (peak ${pk})`);
}

// a song that reaches AddmusicK's own samples from its #path ("../optimized/…", as downloads made
// with the default sample group do): not missing, and found though samples/<#path> doesn't exist
{
  const z = unzipSync(testSongZip());
  const txt = strFromU8(z['Square Test/Square Test.txt']).replace('#optimized', '"../optimized/00 SMW @0.brr"\n\t"../EMPTY.brr"');
  z['Square Test/Square Test.txt'] = strToU8(txt);
  const sf2 = songsFromZip('Dot Dot.zip', zipSync(z));
  check(sf2.missing.length === 0, `AddmusicK's samples via ../ not missing (${sf2.missing.join(', ')})`);
  const p2 = emptyMusicProject();
  const [s2] = addSongs(p2, sf2);
  const r2 = await songSpcs(p2, [s2.file]);
  check(!!spcOf(r2.spcs, s2.file) && r2.errors.length === 0, `SPC of a song with ../ samples (${r2.errors.join(' ')})`);
}

// level 106 set to the song of header setting 2 of the original driver (installs the music patch before
// inserting, so the editor's patches are part of the ROM to restore)
const vanillaSong = rom.r8(0x0584db + 2);
setLevelMusic(rom, 0x106, vanillaSong);
const beforeAmk = rom.data.slice();

// insert
const t0 = Date.now();
const r = await saveMusicProject(rom, p);
check(r.ok, `inserted in ${Date.now() - t0} ms ${r.errors.join(' | ')}`);
if (!r.ok) console.log(r.log.slice(-2000));
check(hasAmk(rom) && musicEntry(rom)?.kind === 'music', 'AddmusicK in the ROM and registered');
const back = loadMusicProject(rom);
check(back?.songs.length === 1 && back.files.size === p.files.size, 'project stored in the ROM');
const songs = romSongs(rom, back);
check(songs.some((s) => s.num === 0x29 && s.kind === 'custom') && songs.some((s) => s.num === 0x0a && s.kind === 'original'), `song list: ${songs.length} songs`);

// levels look the same as before
{
  const a = new LevelEmulator(new Rom(beforeAmk)), b = new LevelEmulator(rom);
  let same = 0;
  const levels = [0x105, 0x106, 0x1c7, 0x0f, 0x101, 0x13b];
  for (const lv of levels) {
    const x = a.load(lv), y = b.load(lv);
    let d = 0;
    for (let i = 0xc800; i < 0xc800 + 0x3800; i++) if (x.wram[i] !== y.wram[i] || x.wram[i + 0x10000] !== y.wram[i + 0x10000]) d++;
    if (y.ok && d === 0) same++;
  }
  check(same === levels.length, `levels load the same (${same}/${levels.length})`);
}

check(levelMusic(rom, 0x106) === rom.r8(0x0584db + 2) && rom.r8(0x0584db + 2) !== vanillaSong,
  `level 106 keeps the same song under its AddmusicK number (${vanillaSong.toString(16)} → ${levelMusic(rom, 0x106).toString(16)})`);
setLevelMusic(rom, 0x105, 0x29);
check(levelMusic(rom, 0x105) === 0x29, 'level 105 set to song 29');

// the level plays the song: in a game in progress (as in the test mode), with the sound unit
{
  const emu = new LevelEmulator(rom);
  emu.snes.apu = new Apu();
  emu.boot();
  emu.startGame(0x29);
  const lr = emu.load(0x105, { continueState: true, translevel: 0x29 });
  const s = emu.snes;
  let pk = 0;
  for (let f = 0; f < 240; f++) { s.runFrame(); if (s.audio && f > 60) pk = Math.max(pk, peak(s.audio)); }
  check(lr.ok, `level loads with the sound unit (${lr.error ?? ''})`);
  check(s.wram[0x1b000] === 0x29, `AddmusicK's current song is 29 (${s.wram[0x1b000].toString(16)})`);
  check(pk > 1000, `sound in the level (peak ${pk})`);
}

// remove everything again
removeSong(p, 0x29);
check(p.files.size === 0 && folders(p).size === 0, 'song files removed with the song');
const r2 = await saveMusicProject(rom, p);
check(r2.ok && !musicEntry(rom) && !hasAmk(rom), `empty project removes AddmusicK ${r2.errors.join(' ')}`);
check(levelMusic(rom, 0x106) === vanillaSong && levelMusic(rom, 0x105) === 0, `level settings back to the original driver's numbers (106: ${levelMusic(rom, 0x106).toString(16)}, 105: ${levelMusic(rom, 0x105)})`);
let diff = 0;
for (let i = 0; i < 0x80000; i++) if (rom.data[i] !== beforeAmk[i] && !(i >= 0x7fdc && i < 0x7fe0) && i !== 0x7fd7) { diff++; console.log('  differs', i.toString(16), beforeAmk[i].toString(16), rom.data[i].toString(16)); }
check(diff === 0, `original ROM area restored, apart from size and checksum (${diff} bytes differ)`);

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
