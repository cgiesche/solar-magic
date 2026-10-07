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
import { setLevelMusic, levelMusic, installEditorPatch } from '../src/core/patches.ts';
import { RESERVED_TOP } from '../src/core/rom.ts';
import {
  emptyMusicProject, songsFromZip, addSongs, saveMusicProject, loadMusicProject, musicEntry, hasAmk, romSongs,
  songSpcs, spcOf, removeSong, folders, songDefines, songWithDefines,
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

// a song whose sample group the readme defines for "Addmusic_sample groups.txt", in #SAMPLES written in
// capitals, with channel 0 reached by a replacement ("Channel # = #" … "Channel #0", as in Faith in Wily)
{
  const z = unzipSync(testSongZip());
  const txt = strFromU8(z['Square Test/Square Test.txt']).replace('#samples', '#SAMPLES').replace('#optimized', '#mygroup')
    .replace('#0 @30', '"Channel # = #"\nChannel #0 @30');
  z['Square Test/Square Test.txt'] = strToU8(txt);
  z['Square Test/readme.txt'] = strToU8('Add this to Addmusic_sample groups.txt:\n#mygroup\n{\n\t"optimized/00 SMW @0.brr"!\n\t"EMPTY.brr"!\n}\n');
  const sf3 = songsFromZip('Group.zip', zipSync(z));
  check(sf3.songs.length === 1 && sf3.missing.length === 0, `song with its own sample group found (${sf3.songs.length}; ${sf3.missing.join(', ')})`);
  const p3 = emptyMusicProject();
  const [s3] = addSongs(p3, sf3);
  const r3 = await songSpcs(p3, [s3.file]);
  check(!!spcOf(r3.spcs, s3.file) && r3.errors.length === 0, `SPC of a song with its own sample group (${r3.errors.join(' ')})`);
  z['Square Test/readme.txt'] = strToU8('Insert with AddmusicK.');
  check(songsFromZip('Group.zip', zipSync(z)).missing.includes('sample group #mygroup'), 'undefined sample group reported missing');
}

// a song's volume: its global volume scaled (here set by the song, and the driver's default for one
// that sets none), so its SPC plays about that much louder or quieter
{
  const rms = (spc: Uint8Array | null | undefined) => {
    if (!spc) return 0;
    const a = new Apu(); a.loadSpc(spc);
    const o = a.play(32000 * 2); let t = 0;
    for (const v of o) t += v * v;
    return Math.sqrt(t / o.length);
  };
  const orig = strFromU8(unzipSync(testSongZip())['Square Test/Square Test.txt']);
  for (const [what, txt] of [['without "w"', orig.replace('t40 w200', 't40')], ['with "w"', orig.replace('t40 w200', 't40 w100')]] as const) {
    const z = unzipSync(testSongZip());
    z['Square Test/Square Test.txt'] = strToU8(txt);
    const pv = emptyMusicProject();
    const [sv] = addSongs(pv, songsFromZip('Vol.zip', zipSync(z)));
    const loud = async (volume: number) => { sv.volume = volume; return rms(spcOf((await songSpcs(pv, [sv.file])).spcs, sv.file)); };
    const base = await loud(100), half = await loud(50), dbl = await loud(200);
    check(base > 0 && Math.abs(half / base - 0.5) < 0.08 && Math.abs(dbl / base - 2) < 0.3,
      `song volume ${what}: 50% → ${(half / base).toFixed(2)}, 200% → ${(dbl / base).toFixed(2)}`);
  }
}

// a song's settings: its #defines as AddmusicK's preprocessor takes them – choices from "#if NAME == v"
// (labelled by the "; v = text" lines after the define), a flag tested with #ifdef, directives in
// comments counted (the preprocessor runs before comments go), in quotes not – set when it is compiled,
// the file otherwise as it was
{
  const orig = strFromU8(unzipSync(testSongZip())['Square Test/Square Test.txt']);
  const txt = orig.replace('#0 @30 v220', `;=====;
; Loudness
;=====;

; how loud it is
\t#define LOUD 1 ; 1 - 2

; 1 = full
; 2 = soft

; silence:
#define MUTE
; "#define NOPE 1" not here, but the next is: #define LATE 3

#0 @30
#if LOUD == 1 ; Full
v220
#endif
#if LOUD == 2 ; Soft
v60
#endif
#ifdef MUTE
v0
#endif
`);
  const defs = songDefines(txt);
  const loud = defs.find((d) => d.name === 'LOUD'), mute = defs.find((d) => d.name === 'MUTE');
  check(defs.length === 3 && defs[2]?.name === 'LATE' && defs[2].value === '3' && loud?.value === '1' && loud.section === 'Loudness' && loud.doc === 'how loud it is' && loud.comment === '1 - 2'
    && JSON.stringify(loud.choices) === JSON.stringify([{ value: '1', label: 'full' }, { value: '2', label: 'soft' }]),
    `song settings found: a choice with labels (${JSON.stringify(loud)})`);
  check(!!mute && mute.flag && mute.value === '' && mute.doc === 'silence:', `a flag (${JSON.stringify(mute)})`);
  const set = songWithDefines(txt, { LOUD: '2', MUTE: null });
  check(set === txt.replace('#define LOUD 1', '#define LOUD 2').replace('#define MUTE\n', '\n'), 'settings set in the song text (a flag turned off taken out), the rest unchanged');
  const z = unzipSync(testSongZip());
  z['Square Test/Square Test.txt'] = strToU8(txt);
  const pd = emptyMusicProject();
  const [sd] = addSongs(pd, songsFromZip('Defs.zip', zipSync(z)));
  const peakOf = async (defines?: Record<string, string | null>) => {
    sd.defines = defines;
    const r = await songSpcs(pd, [sd.file]);
    const spc = spcOf(r.spcs, sd.file);
    if (!spc) { console.log('  ', r.errors.join(' ')); return -1; }
    const a = new Apu(); a.loadSpc(spc);
    return peak(a.play(32000));
  };
  const muted = await peakOf(), full = await peakOf({ MUTE: null }), soft = await peakOf({ LOUD: '2', MUTE: null });
  check(full > 1000 && soft > 0 && soft < full * 0.6 && muted === 0, `settings take effect when compiled (peak ${full}, soft ${soft}, muted ${muted})`);
  check(strFromU8(pd.files.get(sd.file)!) === txt, 'the song file stays as it came');
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

// a 4 MB ROM with the editor patch: the temporary tags over the reserved banks are not taken for
// AddmusicK's writes, and the banks come out as they were
{
  const big = new Rom(vanilla.data.slice());
  big.expand(0x400000);
  installEditorPatch(big);
  const top = big.data.slice(RESERVED_TOP);
  const pb = emptyMusicProject();
  addSongs(pb, songsFromZip('Square Test.zip', testSongZip()));
  const rb = await saveMusicProject(big, pb);
  check(rb.ok && hasAmk(big), `songs inserted into a 4 MB ROM (${rb.errors.join(' ')})`);
  check(big.data.subarray(RESERVED_TOP).every((b, i) => b === top[i]), 'reserved banks unchanged');
}

// a big song (two samples, nearly all of the sound unit's memory) takes long to upload when the level
// fades in, in level 11A beyond the 120 frames a level load may take otherwise: the level still loads
// with the sound unit emulated (as the editor's music player does)
{
  const rb = new Rom(vanilla.data.slice());
  const pb = emptyMusicProject();
  addSongs(pb, songsFromZip('Big.zip', testSongZip(1950, 1)));
  const sb = await saveMusicProject(rb, pb);
  const emu = new LevelEmulator(rb);
  emu.snes.apu = new Apu();
  const lr = emu.load(0x11a, { music: 0x29 });
  check(sb.ok && lr.ok, `level loads with a big song (${sb.errors.join(' ')}${lr.error ?? ''})`);
}

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
