// Editor data outside the ROM image: sources of patches, packages and projects live in rom.extra (not
// in RATS blocks), travel with a project file (outputProject → Rom.fromFile) and are left out of the
// playable ROM, which can still remove its patches. Older ROMs with sources in the ROM are migrated;
// undo/redo restores the editor data too.
// node tools/testextra.ts
import { readFileSync } from 'node:fs';
import { strToU8 } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch, uninstallPatch } from '../src/core/patchapply.ts';
import { listPatches, patchArchive, writeChunks, migratePatchSources } from '../src/core/patchreg.ts';
import { savePackage, packageArchive, listPackages, emptyParts, migratePackageFiles } from '../src/core/pkgreg.ts';
import { emptyMusicProject, songsFromZip, addSongs, saveMusicProject, loadMusicProject } from '../src/core/music.ts';
import { RomHistory } from '../src/core/romhistory.ts';
import { testSongZip } from './testsong.ts';
import { editorImage } from './fixture.ts';

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };
const zipsInRom = (rom: Rom) => rom.scanRats().filter((b) => rom.data[b.start + 8] === 0x50 && rom.data[b.start + 9] === 0x4b).length;

await loadAsar();
const vanilla = new Rom(await editorImage()); // the fixture as the editor opens it
const rom = new Rom(vanilla.data.slice());

// a patch with sources, a package with files, the music project
const archive = strToU8('PK\u0003\u0004 pretend zip of the patch sources');
const patch = applyPatch(rom, { name: 'Test patch', main: 'p.asm', files: new Map([['p.asm', 'org $00D0B6\ndb $EA, $EA']]), archive });
check(patch.ok, `patch applied ${patch.errors.join(' ')}`);
savePackage(rom, { id: 'P1', name: 'Pkg', fileName: 'pkg.zip', added: new Date().toISOString(), ...emptyParts(), patches: [patch.entry!.id] }, strToU8('PK\u0003\u0004 package files'));
const mp = emptyMusicProject();
addSongs(mp, songsFromZip('Square Test.zip', testSongZip()));
const mr = await saveMusicProject(rom, mp);
check(mr.ok, `music inserted ${mr.errors.join(' ')}`);
check(zipsInRom(rom) === 0, 'no source archives in the ROM image');
check(rom.extra.size === 3, `three blobs in the editor data (${rom.extra.size})`);

// project file round trip
const proj = rom.outputProject(false);
check(proj.length > rom.data.length, 'project file is ROM + editor data');
const back = Rom.fromFile(proj);
check(back.data.length === rom.data.length && back.smcHeader === null, 'ROM part read back (no header taken for the appendix)');
const e = listPatches(back).find((p) => p.name === 'Test patch')!;
check(!!patchArchive(back, e) && new TextDecoder().decode(patchArchive(back, e)!).includes('patch sources'), 'patch sources back from the project file');
check(!!packageArchive(back, listPackages(back)[0]), 'package files back');
check(loadMusicProject(back)?.songs.length === 1, 'music project back');
{
  const withHeader = new Rom(new Uint8Array([...new Uint8Array(512), ...rom.data]));
  withHeader.extra = new Map(rom.extra);
  const b2 = Rom.fromFile(withHeader.outputProject(true));
  check(b2.smcHeader !== null && b2.extra.size === 3, 'project file with copier header');
}

// playable ROM: no sources, patches still removable
const playable = Rom.fromFile(rom.output(false));
check(playable.extra.size === 0, 'playable ROM has no editor data');
let threw = '';
try { loadMusicProject(playable); } catch (err) { threw = String(err); }
check(/project file/.test(threw), 'missing music sources reported');
const pe = listPatches(playable).find((p) => p.name === 'Test patch')!;
check(patchArchive(playable, pe) === null, 'patch sources missing');
uninstallPatch(playable, pe.id);
check(playable.data[0x50b6] === vanilla.data[0x50b6] && playable.data[0x50b7] === vanilla.data[0x50b7], 'patch removed from the playable ROM');

// migration of a ROM with sources in RATS blocks (as older versions stored them)
{
  const old = Rom.fromFile(rom.output(false)); // registry entries point to blobs that are gone
  const reg = old.scanRats().find((b) => String.fromCharCode(...old.data.subarray(b.start + 8, b.start + 12)) === 'SMWA')!;
  const json = JSON.parse(new TextDecoder().decode(old.data.subarray(reg.start + 13, reg.start + 8 + reg.size)));
  const src = strToU8('PK\u0003\u0004 old sources');
  for (const p of json.patches) { delete p.srcId; p.src = writeChunks(old, src); p.srcSize = src.length; }
  old.data.fill(0, reg.start, reg.start + 8 + reg.size);
  const j = strToU8(JSON.stringify(json));
  old.allocWrite(new Uint8Array([0x53, 0x4d, 0x57, 0x41, 1, ...j]));
  const zipsBefore = zipsInRom(old);
  check(zipsBefore > 0, `old-style sources in the ROM (${zipsBefore})`);
  check(migratePatchSources(old) && zipsInRom(old) === 0, 'migrated: no source blocks left in the ROM');
  check(listPatches(old).every((p) => !p.src && p.srcId && new TextDecoder().decode(patchArchive(old, p)!).includes('old sources')), 'sources now in the editor data');
  check(!migratePatchSources(old) && !migratePackageFiles(old), 'nothing more to migrate');
}

// undo/redo keeps the editor data in step
{
  const h = new RomHistory(rom);
  const n = rom.extra.size;
  h.begin('patch');
  const r2 = applyPatch(rom, { name: 'Undo patch', main: 'q.asm', files: new Map([['q.asm', 'org $00D0B8\ndb $EA']]), archive: strToU8('PK\u0003\u0004 q') });
  h.commit();
  check(r2.ok && rom.extra.size === n + 1, 'patch adds a blob');
  h.undo();
  check(rom.extra.size === n && !listPatches(rom).some((p) => p.name === 'Undo patch'), 'undo removes patch and blob');
  h.redo();
  check(rom.extra.size === n + 1 && !!patchArchive(rom, listPatches(rom).find((p) => p.name === 'Undo patch')!), 'redo brings both back');
}

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
