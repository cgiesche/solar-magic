// Package record sections (core/pkgsections.ts): for every section a package that brings it is
// recorded with it and removing the package gives the ROM as before. A new section without a sample
// here fails, so each adapter is checked.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadApu } from '../src/core/apu.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { loadProject, saveProject, emptyProject, removeCall } from '../src/core/uberproject.ts';
import { loadPixiProject } from '../src/core/pixi.ts';
import { loadBowsieProject } from '../src/core/bowsie.ts';
import { TOOL_KINDS, type ToolKind } from '../src/core/parts.ts';
import { loadBlockProject, saveBlockProject, type BlockProject } from '../src/core/blocks.ts';
import { importGfxFile } from '../src/core/gfxfiles.ts';
import { installEditorPatch, setLevelMusic } from '../src/core/patches.ts';
import { enableBlocks, setExtTileWords, EXT_FIRST } from '../src/core/map16ext.ts';
import { installBgMap16Ext, setBgExtTileWords, BG_EXT_FIRST } from '../src/core/bgmap16.ts';
import { recordPackageChange, uninstallPackage, listPackages, packageSummary, type Package } from '../src/core/pkgreg.ts';
import { SECTIONS, SECTION_KEYS, toolContent, looseFiles, type SectionKey, type PartSection, type ToolProjects } from '../src/core/pkgsections.ts';
import { inspectUpload, installPackage, type InstallOptions, type ReadyPreview } from '../src/core/packages.ts';
import { setSharedColor } from '../src/core/sharedpal.ts';
import { setGlobalGfx, cleanGlobalGfx } from '../src/core/globalgfx.ts';
import { placeGlobalSlots } from '../src/core/levelgfx.ts';
import { testSongZip } from './testsong.ts';
import { zipSync, unzipSync } from 'fflate';
import { editorImage, romDiff } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

await loadAsar();
await loadApu();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();
const fixture = (f: string) => new Uint8Array(readFileSync('test/fixtures/' + f));

const rom = new Rom(EDITOR_IMAGE.slice());
const emu = new LevelEmulator(rom);
const src = map16Source(rom, emu.load(0x105));
const blank = src.fg(0x025);
const opts: InstallOptions = { level: 0x105, blank, tileWords: (t) => src.fg(t) };
// what the samples need and keeps (the editor's own patches stay when a package is removed)
installEditorPatch(rom);
enableBlocks(rom, blank);
installBgMap16Ext(rom);
setLevelMusic(rom, 0x105, 1); setLevelMusic(rom, 0x105, 0);

const ok = (r: { ok: boolean; errors: string[] }) => { if (!r.ok) throw new Error(r.errors.join(' ')); return { ok: true }; };
const record = (name: string, change: () => { ok: boolean }) => recordPackageChange(rom, { name, fileName: name }, change).pkg;
const install = async (name: string, data: Uint8Array) => (await installPackage(rom, inspectUpload(name, data) as ReadyPreview, opts)).pkg;
const block = 'db $42\nJMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code\nCode:\n  RTL\n';

// a package bringing (at least) the section
const samples: Record<SectionKey, () => Promise<Package | null> | Package | null> = {
  patches: () => record('patch', () => ok(applyPatch(rom, { files: new Map([['p.asm', 'org $00A1DA\n  db $EA\n']]), main: 'p.asm', name: 'P' }))),
  uberasm: () => record('uberasm', () => {
    const p = loadProject(rom) ?? emptyProject();
    p.files.set('level/u.asm', enc.encode('main:\n  RTL\n'));
    p.list.level.set(0x105, [{ file: 'level/u.asm', bytes: [] }]);
    return ok(saveProject(rom, p));
  }),
  block: () => record('block', () => {
    const p: BlockProject = loadBlockProject(rom) ?? { files: new Map(), list: [] };
    p.files.set('blocks/b.asm', enc.encode(block));
    p.list.push({ tile: 0x2a0, file: 'blocks/b.asm' });
    return ok(saveBlockProject(rom, p));
  }),
  sprite: () => install('BrutalBill.zip', fixture('BrutalBill.zip')),
  // (BOWSIE's Piranha Plant with the defines it includes)
  owsprite: () => install('Piranha.zip', zipSync(Object.fromEntries(Object.entries(unzipSync(fixture('BOWSIE originals.zip'))).filter(([k]) => /PiranhaPlant|OriginalSMWSpriteDefines/.test(k))))),
  gfx: () => record('gfx', () => { importGfxFile(rom, 0x90, new Uint8Array(0x1000).fill(0x33)); return { ok: true }; }),
  music: () => install('Song.zip', testSongZip()),
  sfx: () => install('Sfx.zip', zipSync({ '1DFC/Death Prelude.txt': enc.encode('$DA $02 $04 $30 $B4 $B2 $B4') })),
  map16: () => record('map16', () => { setExtTileWords(rom, EXT_FIRST + 0x40, [1, 2, 3, 4]); return { ok: true }; }),
  bgMap16: () => record('bgMap16', () => { setBgExtTileWords(rom, BG_EXT_FIRST + 0x40, [5, 6, 7, 8]); return { ok: true }; }),
  globalGfx: () => record('globalGfx', () => { setGlobalGfx(rom, 0x33, cleanGlobalGfx(rom, 0x33)!.map((v) => v ^ 0xff)); return { ok: true }; }),
  sharedPal: () => record('sharedPal', () => { setSharedColor(rom, 0x10, 0x1234); return { ok: true }; }),
  // a tile slot with its frame copied into the global list's Anim graphic
  globalAnim: () => record('globalAnim', () => {
    placeGlobalSlots(rom, [{ type: 0x01, trigger: 0, framesLess1: 0, dest: 0x8000 | 0x2f00, frames: [0x20] }], { an2: null, alt: new Uint8Array(0x40).fill(0x77) });
    return { ok: true };
  }),
};

// what of a tool project the package has (the Packages tab shows it): its entries, its other files; its
// files are none no package brought; an UberASM call taken out leaves its file
const loadTool = { uberasm: loadProject, block: loadBlockProject, sprite: loadPixiProject, owsprite: loadBowsieProject } as const;
function toolChecks(pkg: Package, k: ToolKind): void {
  const proj = loadTool[k](rom)! as ToolProjects[ToolKind];
  const c = toolContent(pkg, k, proj as never);
  check(c.entries.length > 0 && c.rest.every((f) => pkg[k].files.includes(f)), `section ${k}: its entries in the project (${c.entries.length}, ${c.rest.length} other file(s))`);
  check(!looseFiles([pkg], k, proj).length && looseFiles([], k, proj).length >= pkg[k].files.length, `section ${k}: its files are the package's, not loose`);
  if (k !== 'uberasm') return;
  const p = proj as ToolProjects['uberasm'];
  for (const [ctx, num, file] of pkg.uberasm.calls) removeCall(p, ctx, num, file);
  const after = toolContent(pkg, 'uberasm', p);
  check(!after.entries.length && pkg.uberasm.calls.every(([, , f]) => after.rest.includes(f)) && !p.list.level.has(0x105), 'section uberasm: a call taken out (removeCall) leaves its file, shown with the other files');
}

for (const k of SECTION_KEYS) {
  const sec = SECTIONS[k] as PartSection<unknown, unknown>;
  const sample = samples[k];
  if (!sample) { check(false, `section ${k}: a sample package`); continue; }
  const before = rom.data.slice();
  const pkg = await sample();
  check(!!pkg && pkg[k] !== undefined && !sec.empty(pkg[k]) && !!sec.summary(pkg[k]), `section ${k}: recorded (${pkg && packageSummary(pkg).join(', ')})`);
  if (!pkg) continue;
  if ((TOOL_KINDS as string[]).includes(k)) toolChecks(pkg, k as ToolKind);
  await uninstallPackage(rom, pkg.id, blank);
  // the checksum (AddmusicK rewrites it) doesn't count
  const diff = romDiff(rom.data, before, (i) => i >= 0x7fdc && i < 0x7fe0);
  check(diff === 0 && !listPackages(rom).length, `section ${k}: removing the package gives the ROM as before (${diff} bytes differ)`);
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
