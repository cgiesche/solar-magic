// Custom sound effects (core/sfx.ts): found in an upload's 1DF9/1DFC folders with the author's numbers
// from its "Addmusic_sound effects.txt", numbered (the author's when free, else the lowest free one),
// the defines of code playing one linked; inserted with AddmusicK they play in the game when their
// number is written to $1DFC, and removing them takes AddmusicK out again.
// node tools/testsfx.ts
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { Apu, loadApu } from '../src/core/apu.ts';
import { findSfx, sfxNumbers, sfxLinks, parseSfxList } from '../src/core/sfx.ts';
import { emptyMusicProject, addSfx, removeSfx, sfxKey, saveMusicProject, loadMusicProject, hasAmk, musicEntry } from '../src/core/music.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadProject } from '../src/core/uberproject.ts';
import { inspectUpload, installPackage, removePackage, type ReadyPreview } from '../src/core/packages.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { zipSync } from 'fflate';
import { editorImage, romDiff } from './fixture.ts';

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const enc = new TextEncoder();
const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));
const peak = (a: Int16Array) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

// the Death Prelude of the Retry System (kkevinm), as the Romhack Races baserom has it
const PRELUDE = '$DA $02 $04 $30 $B4 $B2 $B4';
const upload = files({
  'tools/AddmusicK/1DFC/Death Prelude.txt': PRELUDE,
  'tools/AddmusicK/1DF9/Boing.txt': '$DA $00 $10 $A4',
  'setup/lists/Addmusic_sound effects.txt': 'SFX1DF9:\n1\t01 Hit head.txt\n30  Boing.txt\n\nSFX1DFC:\n1\t01 Coin.txt\n1B *\t1A Grinder click 1.txt\n38  Death Prelude.txt\n',
  'settings.asm': '!death_sfx = $38\n!death_sfx_addr = $1DFC\n!option_sfx = $01\n!option_sfx_addr = $1DFC\n!other_sfx = $38\n!other_sfx_addr = $1DF9\n!boing_sound = $00 ; plays Boing\n!count = $38\n!boings = 50 ; Boing count\n',
});

// ---------- in an upload ----------

{
  check(parseSfxList('SFX1DF9:\n1B *\t1A Grinder click 1.txt\n2 ?  x.txt\n').get('1DF9/x.txt') === 2 && parseSfxList('SFX1DF9:\n1B *\t1A Grinder.txt\n').size === 0,
    'list: numbers by bank and name, pointers ("*") left out, "?" read');
  const found = findSfx(upload);
  const prelude = found.find((s) => s.rel === 'Death Prelude.txt');
  check(found.length === 2 && prelude?.bank === '1DFC' && prelude.author === 0x38 && found.find((s) => s.rel === 'Boing.txt')?.author === 0x30,
    `found by their bank's folder, numbered by the author's list (${found.map((s) => `${s.bank} ${s.rel} ${s.author}`).join(', ')})`);
  check(findSfx(files({ '1DFC/x.txt': PRELUDE }))[0]?.author === null, 'without a list: no author\'s number');

  // numbers: the author's when free, else the lowest free one of the bank
  const nums = (n: number[]) => found.map((f, i) => `${f.rel}:${n[i].toString(16)}`).sort().join();
  check(nums(sfxNumbers([], found)) === 'Boing.txt:30,Death Prelude.txt:38', 'the author\'s numbers when free');
  const taken = [{ bank: '1DFC' as const, num: 0x38, file: 'other/x.txt', name: 'x' }];
  check(nums(sfxNumbers(taken, found)) === 'Boing.txt:30,Death Prelude.txt:39', 'one taken by another custom sound effect: the next free one (39)');
  check(sfxNumbers([], [{ ...prelude!, author: 0x05 }]).join() === '56' && sfxNumbers([], [{ ...prelude!, author: null }]).join() === '56',
    'AddmusicK\'s own (1DFC 01–37) are taken: 38');

  // the defines of code playing them
  const links = sfxLinks(upload, found).map((l) => `${l.define}:${found[l.sfx].rel}`);
  check(links.join() === 'death_sfx:Death Prelude.txt,boing_sound:Boing.txt',
    `linked: the define set to its number with its bank next to it, one named like a sound effect naming it in its comment – not one of another bank, nor one not named like a sound effect (by its value or its comment) (${links.join(', ')})`);
}

// ---------- inserted with AddmusicK ----------

await loadApu();
const vanilla = new Rom(await editorImage());
const rom = new Rom(vanilla.data.slice());
const p = emptyMusicProject();
const [s] = addSfx(p, 'Retry.zip', [{ bank: '1DFC', rel: 'Death Prelude.txt', num: 0x38, data: enc.encode(PRELUDE) }]);
check(s.file === 'Retry/Death Prelude.txt' && p.sfxFiles.has('1DFC/Retry/Death Prelude.txt'), `kept in a folder of the upload's name in its bank (${s.file})`);
const r = await saveMusicProject(rom, p);
check(r.ok && hasAmk(rom) && !!musicEntry(rom), `a project of only a sound effect inserts AddmusicK (${r.errors.join(' ')})`);
check(loadMusicProject(rom)?.sfx.map(sfxKey).join() === '1DFC/Retry/Death Prelude.txt', 'kept in the project in the ROM');

// it plays: written to $1DFC in a level, the sound unit sounds (none before)
{
  const emu = new LevelEmulator(rom);
  emu.snes.apu = new Apu();
  emu.boot();
  const ps = PlaySession.start(emu, 0x105, { ov: { music: 0 } });
  const sn = emu.snes;
  ps.play(32);
  // the song muted: the sound effect's voice alone
  sn.apu!.mute(0x7f);
  let before = 0, after = 0;
  for (let f = 0; f < 30; f++) { ps.frame(); before = Math.max(before, peak(ps.audio!)); }
  sn.wram[0x1dfc] = 0x38;
  for (let f = 0; f < 60; f++) { ps.frame(); after = Math.max(after, peak(ps.audio!)); }
  check(ps.ready && before < 100 && after > 1000, `$1DFC = 38 plays it (peak ${before} → ${after})`);
}

removeSfx(p, '1DFC/Retry/Death Prelude.txt');
const r2 = await saveMusicProject(rom, p);
// (but the size it grew to and the checksum)
const diff = romDiff(vanilla.data, rom.data.subarray(0, vanilla.data.length), (i) => i === 0x7fd7 || (i >= 0x7fdc && i < 0x7fe0));
check(r2.ok && !hasAmk(rom) && diff === 0, `removed: AddmusicK out again, the ROM as before (${r2.errors.join(' ')}${diff} bytes differ)`);

// ---------- in packages ----------

// a package playing its sound effect from UberASM code (when $7FB800 is set), the author's 38 taken by
// another package: it gets 39 and the define of the code is set to it
{
  await loadAsar();
  const rp = new Rom(vanilla.data.slice());
  const opt = { level: 0x105, blank: [0, 0, 0, 0], tileWords: () => [0, 0, 0, 0], setup: false };
  const z = (o: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc.encode(v)])));
  const first = await installPackage(rp, inspectUpload('Other.zip', z({ '1DFC/Other.txt': PRELUDE })) as ReadyPreview, opt);
  check(first.ok && loadMusicProject(rp)?.sfx[0]?.num === 0x38, `a package without a list: the lowest free number, 38 (${first.errors.join(' ')})`);
  const preview = inspectUpload('Retry.zip', z({
    '1DFC/Death Prelude.txt': PRELUDE,
    'Addmusic_sound effects.txt': 'SFX1DF9:\n\nSFX1DFC:\n38  Death Prelude.txt\n',
    'gamemode/play.asm': '!death_sfx = $38\n!death_sfx_addr = $1DFC\nmain:\n  LDA $7FB800 : BEQ +\n  LDA #$00 : STA $7FB800\n  LDA #!death_sfx : STA !death_sfx_addr\n+ RTL\n',
  })) as ReadyPreview;
  check(preview.status === 'ready' && preview.parts.map((x) => `${x.kind}:${x.name}`).join() === 'uberasm:play.asm,sfx:Death Prelude' && !preview.unclaimed.length,
    `the upload: UberASM code and the sound effect, its list going with it (${preview.status === 'ready' ? preview.parts.map((x) => x.kind).join() + ' / ' + preview.unclaimed.join() : preview.status})`);
  const r = await installPackage(rp, preview, opt);
  const mine = loadMusicProject(rp)?.sfx.find((x) => x.name === 'Death Prelude');
  const code = new TextDecoder().decode(loadProject(rp)?.files.get('gamemode/play.asm'));
  check(r.ok && mine?.num === 0x39 && code.includes('!death_sfx = $39') && r.warnings.some((w) => w.includes('39 instead of the author\'s $38')),
    `the author's 38 taken: 39, the code's define set to it (${r.errors.join(' ')}${r.warnings.join(' ')})`);
  check(listPackages(rp).find((x) => x.id === r.pkg?.id)?.sfx?.join() === '1DFC/Retry/Death Prelude.txt', 'recorded with the package');
  // the code plays it: 39 sent to $1DFC's port
  const emu = new LevelEmulator(rp);
  const apu = emu.snes.apu = new Apu();
  const write = apu.write.bind(apu);
  const sent: number[] = [];
  apu.write = (t, port, v) => { if (port === 3 && v) sent.push(v); write(t, port, v); };
  emu.boot();
  const ps = PlaySession.start(emu, 0x105);
  ps.play(2);
  sent.length = 0;
  ps.wram[0x1b800] = 1;
  let pk = 0;
  for (let f = 0; f < 30; f++) { ps.frame(); pk = Math.max(pk, peak(ps.audio!)); }
  check(ps.ready && sent.includes(0x39) && pk > 1000, `the code plays it: ${[...new Set(sent)].map((v) => v.toString(16)).join()} sent to $1DFC (peak ${pk})`);
  await removePackage(rp, r.pkg!.id, opt.blank);
  check(loadMusicProject(rp)?.sfx.map((x) => x.name).join() === 'Other', 'removing the package takes its sound effect, the other package\'s stays');
}

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
