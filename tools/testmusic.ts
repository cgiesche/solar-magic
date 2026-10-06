// Music: a generated song with its own BRR sample (zip laid out like a download, the sample in a
// folder other than the song's #path) is inserted with AddmusicK, levels still load the same, a level
// set to the song plays it in the game (emulated with the sound unit), AddmusicK's SPC of the song
// plays, and removing the project restores the ROM.
// node tools/testmusic.ts
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
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

// a looping square wave as BRR: 2-byte loop header (offset 0), then 9-byte blocks of 16 samples
function squareBrr(blocks = 4): Uint8Array {
  const out = new Uint8Array(2 + blocks * 9);
  for (let b = 0; b < blocks; b++) {
    const o = 2 + b * 9;
    out[o] = (11 << 4) | (b === blocks - 1 ? 3 : 0); // shift 11, filter 0, loop+end on the last
    for (let i = 0; i < 8; i++) out[o + 1 + i] = b % 2 ? 0x99 : 0x77; // -7 / +7 per nibble
  }
  return out;
}

export function testSongZip(): Uint8Array {
  const song = `#amk 2
#path "testsong"
#samples
{
	#optimized
	"square.brr"
}
#instruments
{
	"square.brr" $8F $E0 $00 $04 $00
}
#spc
{
	#title "Square Test"
	#author "Solar Magic test"
}
t40 w200
#0 @30 v220 o4 l8 c d e f g a b > c < /
c e g > c < g e c4
`;
  return zipSync({
    'Square Test/Square Test.txt': strToU8(song),
    'Square Test/readme.txt': strToU8('Insert with AddmusicK. Put the samples folder into AddmusicK\'s samples folder.'),
    'Square Test/samples/testsong/square.brr': squareBrr(),
  });
}

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

// the level plays the song (set before inserting, so the editor's patches are part of the ROM to restore)
setLevelMusic(rom, 0x105, 0x29);
check(levelMusic(rom, 0x105) === 0x29, 'level 105 set to song 29');
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
let diff = 0;
for (let i = 0; i < 0x80000; i++) if (rom.data[i] !== beforeAmk[i] && !(i >= 0x7fdc && i < 0x7fe0) && i !== 0x7fd7) { diff++; console.log('  differs', i.toString(16), beforeAmk[i].toString(16), rom.data[i].toString(16)); }
check(diff === 0, `original ROM area restored, apart from size and checksum (${diff} bytes differ)`);

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
