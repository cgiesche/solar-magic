// Editing a file of an installed package's patch (#469): the patch reapplied with the edited file, the edit kept in
// the patch's sources and the package's files, one undo step, nothing changed when Asar fails.
// Fixture: Kevin's More Hardcoded Paths (test/fixtures/more_hardcoded_paths.zip), its tables file edited.

import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { RomHistory } from '../src/core/romhistory.ts';
import { inspectUpload, installPackage, editPackagePatchFile, reapplyPackagePatch, packageFiles, type ReadyPreview } from '../src/core/packages.ts';
import { listPackages, packagePatches, type Package } from '../src/core/pkgreg.ts';
import { patchArchive } from '../src/core/patchreg.ts';
import { unpackUpload, uploadFromFiles, type StoredUpload } from '../src/core/patchpkg.ts';
import { editorImage, romDiff } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const image = await editorImage();
const ZIP = 'more_hardcoded_paths.zip', MAIN = 'more_hardcoded_paths.asm', TABLES = 'more_hardcoded_paths_tables.asm';
const files = unzipSync(new Uint8Array(readFileSync('test/fixtures/' + ZIP)));
// a path of its own added to the tables (as tools/testowhardpaths.ts does): translevel $01 two tiles left
const edit = (s: string) => s.replace(/\r\n/g, '\n').replace(/^levels:\n((?:.*\n)*?)\.05:/m, (m) => `${m}    db $01,$FE`)
  .replace(/^directions:\n((?:.*\n)*?)\.05:/m, (m) => `${m}    db !Left,!Left`)
  .replace(/^\.05_1:\n\.05_2:/m, '.05_1:  db $04,$04,$66\n.05_2:  db $04')
  .replace(/^(animation:\n(?:.*\n)*?)\.05_1:\n\.05_2:/m, '$1.05_1:  db $00,$00,$00\n.05_2:  db $00');
const edited = edit(strFromU8(files[TABLES]));
if (edited === strFromU8(files[TABLES]).replace(/\r\n/g, '\n')) throw new Error('the tables edit changed nothing');

async function installed(zip: Record<string, Uint8Array>): Promise<Rom> {
  const rom = new Rom(image.slice());
  const p = inspectUpload(ZIP, zipSync(zip));
  if (p.status !== 'ready') throw new Error(`${ZIP}: ${p.status}`);
  const r = await installPackage(rom, p as ReadyPreview, { level: 0x105, blank: [0, 0, 0, 0], tileWords: () => [0, 0, 0, 0] }); // (a patch only: no tiles)
  if (!r.ok) throw new Error(r.errors.join(' '));
  return rom;
}
const pkgOf = (rom: Rom): Package => listPackages(rom)[0];
const patchOf = (rom: Rom) => packagePatches(rom, pkgOf(rom))[0];
const stored = (rom: Rom): StoredUpload => unpackUpload(patchArchive(rom, patchOf(rom))!);
const storedText = (rom: Rom, f: string) => strFromU8(new Map(stored(rom).files).get(f)!);
// package registries (SMWK) move and hold ids and dates: not compared
const pkgRegs = (d: Uint8Array) => new Rom(d.slice()).scanRats().filter((r) => [0x53, 0x4d, 0x57, 0x4b].every((m, k) => d[r.start + 8 + k] === m)).map((r) => [r.start, r.start + 8 + r.size]);
const same = (a: Rom, b: Rom) => { const regs = [...pkgRegs(a.data), ...pkgRegs(b.data)]; return romDiff(a.data, b.data, (i) => regs.some(([s, e]) => i >= s && i < e)); };

const direct = await installed({ ...files, [TABLES]: strToU8(edited) });
const rom = await installed(files);
const plain = rom.data.slice(), plainExtra = new Map(rom.extra);
const s = stored(rom);
check(s.files.some(([f]) => f === TABLES) && s.main === MAIN, `the patch's stored sources hold its tables file (${s.files.map(([f]) => f).join(', ')})`);

// the edit: one undo step
const h = new RomHistory(rom);
h.begin('edit');
const r = editPackagePatchFile(rom, patchOf(rom).id, s, TABLES, strToU8(edited), patchOf(rom).defines, pkgOf(rom));
h.commit();
check(r.ok, 'the tables edited: the patch reapplied ' + r.errors.join(' | '));
const diff = same(rom, direct);
check(diff === 0, `the ROM = the package installed with the tables edited (${diff} bytes differ)`);
check(romDiff(rom.data, plain) > 0, 'the ROM changed');
check(storedText(rom, TABLES) === edited && storedText(rom, MAIN) === strFromU8(files[MAIN]), 'the patch\'s stored sources hold the edit (the main file as it was)');
check(strFromU8(packageFiles(rom, pkgOf(rom))!.get(TABLES)!) === edited, 'the package\'s files hold the edit');
check(listPackages(rom).length === 1 && pkgOf(rom).patches.length === 1, 'still one package with one patch');

// a later reapply with the stored sources keeps the edit
{
  const again = new Rom(rom.data.slice()); again.extra = new Map(rom.extra);
  const st = stored(again);
  const up = { ...uploadFromFiles(st.fileName, new Map(st.files)), main: st.main };
  const r2 = reapplyPackagePatch(again, patchOf(again).id, up, st.fileName, st.main, patchOf(again).defines, pkgOf(again));
  check(r2.ok && same(again, direct) === 0 && storedText(again, TABLES) === edited, 'a later reapply keeps the edited tables');
}

// undo: ROM and file back
h.undo();
check(romDiff(rom.data, plain) === 0 && rom.extra.size === plainExtra.size && [...plainExtra].every(([k, v]) => rom.extra.get(k) === v), 'undo: the ROM bytes and editor data as before');
check(storedText(rom, TABLES) === strFromU8(files[TABLES]) && strFromU8(packageFiles(rom, pkgOf(rom))!.get(TABLES)!) === strFromU8(files[TABLES]), 'undo: the tables file\'s old text');

// an Asar error: nothing changes, the error names file and line
{
  const before = rom.data.slice(), extra = new Map(rom.extra);
  const h2 = new RomHistory(rom);
  h2.begin('broken');
  const r3 = editPackagePatchFile(rom, patchOf(rom).id, stored(rom), TABLES, strToU8(edited + '\n    db NoSuchLabel\n'), patchOf(rom).defines, pkgOf(rom));
  if (r3.ok) h2.commit(); else h2.rollback();
  check(!r3.ok && r3.errors.some((e) => e.includes(TABLES) && /:\d+/.test(e)), `an Asar error: reported with file and line (${r3.errors[0] ?? 'none'})`);
  check(romDiff(rom.data, before) === 0 && rom.extra.size === extra.size && [...extra].every(([k, v]) => rom.extra.get(k) === v), 'an Asar error: the ROM and the stored files unchanged');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('package patch edit ok');
