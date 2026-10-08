// Packages (core/packages.ts): what the upload preview reports for each fixture package and made-up
// uploads (single files, tool folders, a package of several kinds, songs, an unrecognizable upload); an
// install has its effect in the emulator and is one package; removing gives the ROM as before, keeping
// files another package brought too (the editor's own patches it needed, like the Map16 extension, stay);
// undoing an install restores ROM bytes and editor data in one step. Patches applied before packages were
// tracked become one legacy package each, once; removing one restores the ROM as before that patch.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadApu } from '../src/core/apu.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { RomHistory } from '../src/core/romhistory.ts';
import { inspectUpload, installPackage, removePackage, wrapLegacyPatches, defaultAssignment, partsSummary, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { applyPatch } from '../src/core/patchapply.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { loadProject } from '../src/core/uberproject.ts';
import { loadBlockProject } from '../src/core/blocks.ts';
import { loadPixiProject } from '../src/core/pixi.ts';
import { loadMusicProject } from '../src/core/music.ts';
import { levelMusic, setLevelMusic, installEditorPatch } from '../src/core/patches.ts';
import { enableBlocks } from '../src/core/map16ext.ts';
import { testSongZip } from './testsong.ts';

await loadAsar();
await loadApu();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();
const fixture = (f: string) => new Uint8Array(readFileSync('test/fixtures/' + f));
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v])));
const kinds = (p: UploadPreview) => (p.status === 'ready' ? p.parts.map((x) => x.kind).sort().join(' ') : p.status);
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };

// ---------- the preview ----------

const shatter = inspectUpload('Aftertouch Shatter.zip', fixture('Aftertouch Shatter.zip'));
check(kinds(shatter) === 'block sprite', `Aftertouch Shatter: a bounce sprite and the block spawning it (${kinds(shatter)})`);
const bill = inspectUpload('BrutalBill.zip', fixture('BrutalBill.zip'));
check(kinds(bill) === 'sprite sprite', `Brutal Bill: sprite and shooter, one package (${kinds(bill)})`);
const rock = inspectUpload('RockClimbBlocksUpdate.zip', fixture('RockClimbBlocksUpdate.zip'));
check(kinds(rock) === 'block block graphics', `Rock Climb Blocks: two blocks and their ExGFX (${kinds(rock)})`);
check(rock.status === 'ready' && partsSummary(rock.parts) === '2 blocks, 1 graphics file', 'summary ' + (rock.status === 'ready' ? partsSummary(rock.parts) : ''));
const retry = inspectUpload('retry-system_v2.2.0.zip', fixture('retry-system_v2.2.0.zip'));
check(retry.status === 'manual' && retry.suggestion.root === 'src/', `Retry System: assigned by hand, with the suggestion (${retry.status})`);
for (const f of ['ghostbustersghosttrapjavamanhattanBG.zip', 'sonicmaniasszact1.zip']) check(inspectUpload(f, fixture(f)).status === 'level-import', `${f}: a level import`);

const patchAsm = 'org $00A1DA\n  db $EA\n';
const uberAsm = 'load:\n  LDA #$11 : STA $7FB001\n  RTL\n';
const blockAsm = 'db $42\nJMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code\nCode:\n  RTL\n';
check(kinds(inspectUpload('nop.asm', enc.encode(patchAsm))) === 'patch', 'single .asm: a patch');
check(kinds(inspectUpload('marker.asm', enc.encode(uberAsm))) === 'uberasm', 'single .asm: UberASM code');
check(kinds(inspectUpload('solid.asm', enc.encode(blockAsm))) === 'block', 'single .asm: a block');
check(kinds(inspectUpload('Square Test.zip', testSongZip())) === 'music', 'AddmusicK song');
const two = inspectUpload('two.zip', zip({ 'a.asm': patchAsm, 'b.asm': patchAsm.replace('A1DA', 'A1DB') }));
check(two.status === 'ready' && two.patch?.candidates.length === 2, 'two patch files: one patch, its main file to choose');

// a boss: sprites, UberASM code and its song – one package of three kinds
const billFiles = unzipSync(fixture('BrutalBill.zip'));
const song = unzipSync(testSongZip());
const boss = inspectUpload('Boss.zip', zip({ ...billFiles, 'uberasm/level/boss.asm': uberAsm, ...Object.fromEntries(Object.entries(song).map(([k, v]) => ['music/' + k, v])) }));
check(kinds(boss) === 'music sprite sprite uberasm', `a package of several kinds is one package (${kinds(boss)})`);

// tool folders as .zip
const uberFolder = inspectUpload('MyUber.zip', zip({ 'list.txt': 'level:\n105 marker.asm\n', 'level/marker.asm': uberAsm, 'library/util.asm': 'Util:\n  RTL\n', 'UberASMTool.exe': 'x' }));
check(kinds(uberFolder) === 'uberasm', `UberASM Tool folder (${kinds(uberFolder)})`);
const gpsFolder = inspectUpload('MyGPS.zip', zip({ 'list.txt': '200 solid.asm\n201 solid2.asm\n', 'blocks/solid.asm': blockAsm, 'blocks/solid2.asm': blockAsm, 'routines/x.asm': 'RTL\n' }));
check(kinds(gpsFolder) === 'block block', `GPS folder (${kinds(gpsFolder)})`);
const pixiFolder = inspectUpload('MyPixi.zip', zip({ 'list.txt': '00 BrutalBill.json\n', ...Object.fromEntries(Object.entries(billFiles).filter(([k]) => k.startsWith('sprites/'))) }));
check(kinds(pixiFolder) === 'sprite', `PIXI folder (${kinds(pixiFolder)})`);

const junk = inspectUpload('stuff.zip', zip({ 'readme.txt': 'hello', 'pic.png': new Uint8Array(30) }));
check(junk.status === 'failed' && /2 files/.test(junk.reason) && /\.png/.test(junk.reason) && /no \.asm/.test(junk.reason), `unrecognizable: says what was found and what is missing (${junk.status === 'failed' ? junk.reason : junk.status})`);

// ---------- install, remove, undo ----------

const rom = new Rom(fixture('smw.smc'));
const emu = new LevelEmulator(rom); emu.boot();
const src = map16Source(rom, emu.load(0x105));
const opts: InstallOptions = { level: 0x105, blank: src.fg(0x025), tileWords: (t) => src.fg(t) };
installEditorPatch(rom);
enableBlocks(rom, opts.blank); // the Map16 extension with custom blocks enabled
setLevelMusic(rom, 0x105, 1); setLevelMusic(rom, 0x105, 0); // the patch for music set per level (stays)
const vanilla = rom.data.slice();
const sameRom = (what: string) => {
  let diff = 0;
  // the checksum (rewritten by AddmusicK) and the ROM size byte don't count
  for (let i = 0; i < rom.data.length; i++) if (rom.data[i] !== (i < vanilla.length ? vanilla[i] : 0) && i !== 0x7fd7 && !(i >= 0x7fdc && i < 0x7fe0)) diff++;
  check(diff === 0 && !listPackages(rom).length, `${what}: ROM as before (${diff} bytes differ)`);
};
const install = async (p: UploadPreview, o: Partial<InstallOptions> = {}) => {
  const r = await installPackage(rom, ready(p), { ...opts, ...o });
  if (!r.ok) console.log('     ', r.errors.join(' | '));
  return r;
};

// UberASM code with a patch: runs in the current level, the patch's byte is in; one package
const mixed = inspectUpload('Mixed.zip', zip({ 'mixed.asm': patchAsm, 'level/marker.asm': uberAsm }));
check(kinds(mixed) === 'patch uberasm', `patch and UberASM code (${kinds(mixed)})`);
const r1 = await install(mixed);
check(r1.ok && listPackages(rom).length === 1 && r1.pkg!.patches.length === 1 && r1.pkg!.uber.calls.length === 1, 'installed as one package with its patch and UberASM call');
{
  const e = new LevelEmulator(rom); e.boot();
  const l5 = e.load(0x105), l6 = e.load(0x106);
  check(l5.ok && l5.wram[0x1b001] === 0x11 && l6.wram[0x1b001] === 0 && rom.data[0x21da] === 0xea, 'in the emulator: the code runs in level 105 only, the patch byte is set');
}

// two packages sharing a library file: removing one keeps it for the other
const shared = 'Shared:\n  RTL\n';
const pa = await install(inspectUpload('A.zip', zip({ 'level/a.asm': 'main:\n  JSL shared_Shared\n  RTL\n', 'library/shared.asm': shared })));
const pb = await install(inspectUpload('B.zip', zip({ 'level/b.asm': 'main:\n  JSL shared_Shared\n  RTL\n', 'library/shared.asm': shared })), { level: 0x106 });
check(pa.ok && pb.ok, 'A and B installed');
await removePackage(rom, pa.pkg!.id, opts.blank);
const up = loadProject(rom)!;
check(!up.files.has('level/a.asm') && up.files.has('library/shared.asm') && up.files.has('level/b.asm'), 'removing A keeps the library file B uses');
await removePackage(rom, pb.pkg!.id, opts.blank);

// sprites and blocks
const rb = await install(bill);
check(rb.ok && loadPixiProject(rom)!.list.length === 2, 'Brutal Bill: sprite and shooter in the PIXI project');
const rr = await install(rock, { level: null }); // with a level, its graphics slots would be set (they stay)
check(rr.ok && loadBlockProject(rom)!.list.length === 2, 'Rock Climb Blocks: two blocks on Map16 tiles');
const rs = await install(shatter);
check(rs.ok && loadPixiProject(rom)!.list.some((e) => e.kind === 'bounce'), 'Aftertouch Shatter: its bounce sprite');
for (const r of [rs, rr, rb, r1]) await removePackage(rom, r.pkg!.id, opts.blank);
sameRom('all removed');

// tool folders
for (const [p, what] of [[uberFolder, 'UberASM Tool folder'], [gpsFolder, 'GPS folder'], [pixiFolder, 'PIXI folder']] as const) {
  const r = await install(p);
  check(r.ok && listPackages(rom).length === 1, `${what}: installed as one package`);
  await removePackage(rom, r.pkg!.id, opts.blank);
}
sameRom('tool folders removed');

// a song: inserted with AddmusicK, set for the current level
const rm = await install(inspectUpload('Square Test.zip', testSongZip()));
check(rm.ok && loadMusicProject(rom)?.songs.length === 1 && levelMusic(rom, 0x105) === loadMusicProject(rom)!.songs[0].num, 'song inserted and set for level 105');
await removePackage(rom, rm.pkg!.id, opts.blank);
sameRom('song removed');

// a failing install leaves the ROM as it was
{
  const r = await install(inspectUpload('broken.asm', enc.encode('org $00A1DA\n  JML NoSuchLabel\n')));
  check(!r.ok && !listPackages(rom).length, 'failing patch: error, nothing recorded');
  sameRom('failed install');
}

// undoing an install: one step, ROM bytes and editor data
{
  const h = new RomHistory(rom);
  const data = rom.data.slice(), extra = new Map(rom.extra);
  h.begin('Install');
  const r = await install(mixed);
  h.commit();
  check(r.ok && h.undoStack.length === 1 && rom.extra.size > extra.size, 'install is one undo step');
  h.undo();
  check(rom.data.length === data.length && rom.data.every((v, i) => v === data[i]) && rom.extra.size === extra.size && [...extra].every(([k, v]) => rom.extra.get(k) === v) && !listPackages(rom).length,
    'undo restores ROM bytes and editor data');
}

// a package assigned by hand: Retry System (by Kevin/kkevinm) with the suggestion – it works in the emulator
{
  if (retry.status !== 'manual') throw new Error('Retry: no manual preview');
  const a = defaultAssignment(retry, 0x105);
  check(a.calls.length === 1 && a.calls[0].file === 'gamemode/retry_gm.asm', 'Retry: the assignment suggested (list.txt line from its readme)');
  const r = await installPackage(rom, retry, { ...opts, assignment: a });
  check(r.ok && !!r.pkg && r.pkg.uber.calls.length === 1 && listPackages(rom).length === 1, 'Retry installed as one package ' + r.errors.slice(0, 2).join(' | '));
  if (r.ok) {
    // falling into a pit: Retry respawns Mario in the level (vanilla: game over with 0 lives)
    const e = new LevelEmulator(rom); e.boot();
    e.load(0x105);
    const t = e.snes;
    let k = 0; while (t.wram[0x100] !== 0x14 && k++ < 200) t.runFrame();
    for (let i = 0; i < 30; i++) t.runFrame();
    t.wram[0x96] = 0xf0; t.wram[0x97] = 0x01;
    const modes: number[] = [];
    for (let i = 0; i < 400; i++) {
      t.runFrame();
      if (modes[modes.length - 1] !== t.wram[0x100]) modes.push(t.wram[0x100]);
      t.joy1 = i >= 200 && i < 204 ? 0x0080 : 0;
    }
    check(modes.includes(0x0f) && modes[modes.length - 1] === 0x14 && !modes.includes(0x15), `in the emulator: Retry respawns in the level (game modes ${modes.map((m) => m.toString(16)).join(' ')})`);
    await removePackage(rom, r.pkg!.id, opts.blank);
  }
  const nothing = await installPackage(rom, retry, { ...opts, assignment: { rules: new Map([['', null]]), calls: [] } });
  check(!nothing.ok && /Nothing/i.test(nothing.errors[0] ?? ''), 'an assignment taking nothing: error');
}

// legacy packages: patches applied before packages were tracked
{
  const pkg = await install(mixed);
  const before = rom.data.slice();
  const ok1 = applyPatch(rom, { files: new Map([['old1.asm', 'org $00A1DF\n  db $EA\n']]), main: 'old1.asm', name: 'Old one' }).ok;
  const ok2 = applyPatch(rom, { files: new Map([['old2.asm', 'org $00A1E4\n  db $EA\n']]), main: 'old2.asm', name: 'Old two' }).ok;
  const wrapped = wrapLegacyPatches(rom);
  const all = listPackages(rom);
  check(ok1 && ok2 && wrapped.length === 2 && all.length === 3 && wrapped.every((r) => r.legacy && r.patches.length === 1), `one legacy package per untracked patch (${wrapped.map((r) => r.name).join(', ')})`);
  check(wrapLegacyPatches(rom).length === 0 && listPackages(rom).length === 3, 'wrapping again creates no duplicates');
  const two = wrapped.find((r) => r.name === 'Old two')!;
  await removePackage(rom, two.id, opts.blank);
  const one = wrapped.find((r) => r.name === 'Old one')!;
  await removePackage(rom, one.id, opts.blank);
  check(rom.data[0x21df] === before[0x21df] && rom.data[0x21e4] === before[0x21e4] && !listPatches(rom).some((p) => p.name.startsWith('Old')) && listPackages(rom).length === 1,
    'removing the legacy packages restores the bytes their patches changed');
  await removePackage(rom, pkg.pkg!.id, opts.blank);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
