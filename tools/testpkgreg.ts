// Installed packages: what a package adds is observed (projects before/after), recorded in the ROM and
// removed again as one – shared files of another package stay, the ROM is as before the package.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { installEditorPatch, gfxEntry } from '../src/core/patches.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { loadProject, saveProject, emptyProject } from '../src/core/uberproject.ts';
import { loadBlockProject, saveBlockProject, type BlockProject } from '../src/core/blocks.ts';
import { importGfxFile } from '../src/core/map16file.ts';
import { snapshot, partsBetween, mergeParts, emptyParts, isEmptyParts, savePackage, listPackages, packageArchive, uninstallPackage, type Package } from '../src/core/pkgreg.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();

const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
installEditorPatch(rom);
const emu = new LevelEmulator(rom); emu.boot();
const blank = map16Source(rom, emu.load(0x105)).fg(0x025);
const block = (n: number) => `db $42\nJMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code\nCode:\n  LDA #$${n.toString(16).padStart(2, '0')} : STA $7FB010\n  RTL\n`;

// adds like the dialogs do and records what came in
const track = (name: string, add: () => void, archive?: Uint8Array, into?: Package): Package => {
  const before = snapshot(rom);
  add();
  const after = snapshot(rom);
  const parts = partsBetween(before, after);
  check(!isEmptyParts(parts), `${name}: parts observed`);
  const rec: Package = into ?? { id: name, name, fileName: name + '.zip', added: new Date().toISOString(), ...emptyParts() };
  return savePackage(rom, mergeParts(rec, parts, after), archive);
};
const ok = (r: { ok: boolean; errors: string[] }) => { if (!r.ok) throw new Error(r.errors.join(' ')); };
const romBefore = rom.data.slice();

// package A: an Asar patch, UberASM code (with a shared routine) and, added afterwards as a part of it, a block
let a = track('A', () => {
  ok(applyPatch(rom, { files: new Map([['a.asm', 'org $00A1DA\n  db $EA\n']]), main: 'a.asm', name: 'A-Patch' }));
  const p = loadProject(rom) ?? emptyProject();
  p.files.set('level/a.asm', enc.encode('main:\n  RTL\n'));
  p.files.set('library/shared.asm', enc.encode('shared:\n  RTL\n'));
  p.list.level.set(0x105, [{ file: 'level/a.asm', bytes: [] }]);
  ok(saveProject(rom, p));
}, enc.encode('archive of A'));
check(a.patches.length === 1 && a.uber.files.length === 2 && a.uber.calls.length === 1 && a.uber.calls[0][1] === 0x105, 'A: patch, UberASM files and call recorded');
a = track('A', () => {
  const p: BlockProject = loadBlockProject(rom) ?? { files: new Map(), list: [] };
  p.files.set('blocks/a.asm', enc.encode(block(1)));
  p.list.push({ tile: 0x2a0, file: 'blocks/a.asm' });
  ok(saveBlockProject(rom, p, blank));
}, undefined, a);
check(a.blocks.tiles.join() === '672' && a.patches.length === 1 && a.uber.files.length === 2, 'a part added later goes into the same record');
check(new TextDecoder().decode(packageArchive(rom, listPackages(rom)[0])!) === 'archive of A', 'package files kept in the ROM');

// package B: shares library/shared.asm, has a block and an ExGFX file
const gfx = new Uint8Array(0x1000).fill(0x55);
track('B', () => {
  const p = loadProject(rom)!;
  p.files.set('level/b.asm', enc.encode('main:\n  RTL\n'));
  p.files.set('library/shared.asm', enc.encode('shared:\n  NOP\n  RTL\n'));
  p.list.level.set(0x106, [{ file: 'level/b.asm', bytes: [] }]);
  ok(saveProject(rom, p));
  const bp = loadBlockProject(rom)!;
  bp.files.set('blocks/b.asm', enc.encode(block(2)));
  bp.list.push({ tile: 0x2a1, file: 'blocks/b.asm' });
  ok(saveBlockProject(rom, bp, blank));
  importGfxFile(rom, 0x80, gfx);
});
const b = listPackages(rom).find((r) => r.id === 'B')!;
check(b.uber.files.includes('library/shared.asm') && b.gfx.join() === '128' && b.blocks.tiles.join() === '673' && !b.patches.length, 'B: changed shared file, block and ExGFX recorded');

// removing A: its patch, call, files and block go; the shared file stays for B
const w = uninstallPackage(rom, 'A', blank);
const up = loadProject(rom)!;
check(!listPatches(rom).some((p) => p.name === 'A-Patch') && rom.r8(0x00a1da) === romBefore[0x21da], 'A: patch removed, byte restored');
check(!up.files.has('level/a.asm') && up.files.has('library/shared.asm') && !up.list.level.has(0x105) && up.list.level.has(0x106), 'A: UberASM file and call removed, shared file kept');
check(loadBlockProject(rom)!.list.map((x) => x.tile).join() === '673', 'A: block removed, B\'s stays');
check(listPackages(rom).map((r) => r.id).join() === 'B', 'A: record removed' + (w.length ? ` (${w.join(' ')})` : ''));

// removing B too: projects and ExGFX gone, the ROM as before both packages
uninstallPackage(rom, 'B', blank);
check(!loadProject(rom) && !loadBlockProject(rom) && !gfxEntry(rom, 0x80) && !listPackages(rom).length, 'B: UberASM, blocks and ExGFX removed');
check(listPatches(rom).length === 0, 'no registry entries left');

// a failing removal leaves the ROM unchanged
{
  const before = rom.data.slice();
  let threw = false;
  try { uninstallPackage(rom, 'nope', blank); } catch { threw = true; }
  check(threw && rom.data.every((v, i) => v === before[i]), 'unknown package: error, ROM unchanged');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
