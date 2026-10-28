// Packages (core/packages.ts): what the upload preview reports for each fixture package and made-up
// uploads (single files, tool folders, a package of several kinds, songs, an unrecognizable upload); an
// install has its effect in the emulator and is one package; removing gives the ROM as before, keeping
// files another package brought too (the editor's own patches it needed, like the Map16 extension, stay);
// undoing an install restores ROM bytes and editor data in one step. The manuals the tool tabs list come
// and go with their packages.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadApu } from '../src/core/apu.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { GM, PAD } from '../src/core/ram.ts';
import { map16Source } from '../src/core/render.ts';
import { RomHistory } from '../src/core/romhistory.ts';
import { inspectUpload, installPackage, removePackage, defaultAssignment, partsSummary, packageManuals, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import type { ToolKind } from '../src/core/parts.ts';
import { loadProject, saveProject } from '../src/core/uberproject.ts';
import { ALL } from '../src/core/uberasm.ts';
import { loadBlockProject, saveBlockProject } from '../src/core/blocks.ts';
import { loadPixiProject, savePixiProject } from '../src/core/pixi.ts';
import { loadMusicProject } from '../src/core/music.ts';
import { loadLevel, newUid } from '../src/core/level.ts';
import { saveLevel } from '../src/core/save.ts';
import { levelMusic, setLevelMusic, installEditorPatch, customPalette, DM16_EXT } from '../src/core/patches.ts';
import { readLevelList, readAltFile, usesAltFile } from '../src/core/exanim.ts';
import { levelColors } from '../src/core/levelgfx.ts';
import { enableBlocks, setExtTileWords } from '../src/core/map16ext.ts';
import { parseLmObjects } from '../src/core/mwl.ts';
import { testSongZip } from './testsong.ts';
import { editorImage, romDiff } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

await loadAsar();
await loadApu();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();
const dec = new TextDecoder();
const fixture = (f: string) => new Uint8Array(readFileSync('test/fixtures/' + f));
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v])));
const kinds = (p: UploadPreview) => (p.status === 'ready' ? p.parts.map((x) => x.kind).sort().join(' ') : p.status);
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };

// ---------- the preview ----------

const shatter = inspectUpload('Aftertouch Shatter.zip', fixture('Aftertouch Shatter.zip'));
check(kinds(shatter) === 'block graphics sprite', `Aftertouch Shatter: a bounce sprite, the block spawning it and its graphics (${kinds(shatter)})`);
const bill = inspectUpload('BrutalBill.zip', fixture('BrutalBill.zip'));
check(kinds(bill) === 'sprite sprite', `Brutal Bill: sprite and shooter, one package (${kinds(bill)})`);
const rock = inspectUpload('RockClimbBlocksUpdate.zip', fixture('RockClimbBlocksUpdate.zip'));
check(kinds(rock) === 'block block graphics graphics', `Rock Climb Blocks: two blocks, their Map16 tiles and ExGFX (${kinds(rock)})`);
check(rock.status === 'ready' && partsSummary(rock.parts) === '2 blocks, 2 graphics files', 'summary ' + (rock.status === 'ready' ? partsSummary(rock.parts) : ''));
const retry = inspectUpload('retry-system_v2.2.0.zip', fixture('retry-system_v2.2.0.zip'));
check(retry.status === 'manual' && retry.suggestion.root === 'src/', `Retry System: assigned by hand, with the suggestion (${retry.status})`);
for (const f of ['ghostbustersghosttrapjavamanhattanBG.zip', 'sonicmaniasszact1.zip']) check(inspectUpload(f, fixture(f)).status === 'level-import', `${f}: a level import`);
// On-Off Blocks (MarioFanGamer): a GPS block, its PIXI bounce sprite, Map16 tiles, ExGFX, a palette and
// a sample level – a package, each file in its part, though it holds a Lunar Magic level
const onoff = inspectUpload('On-Off Block.zip', fixture('On-Off Block.zip'));
check(kinds(onoff) === 'block graphics graphics graphics graphics sprite', `On-Off Blocks: block, sprite and graphics, not a level import (${kinds(onoff)})`);
check(onoff.status === 'ready' && onoff.unclaimed.join() === 'On-Off Blocks - Readme.txt' && onoff.samples.join() === 'SampleLevel.mwl', `On-Off Blocks: only the readme not installed, the .mwl its sample level (${onoff.status === 'ready' ? onoff.unclaimed.join() : ''})`);

const patchAsm = 'org $00A1DA\n  db $EA\n';
const uberAsm = 'load:\n  LDA #$11 : STA $7FB001\n  RTL\n';
const blockAsm = 'db $42\nJMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code : JMP Code\nCode:\n  RTL\n';
check(kinds(inspectUpload('nop.asm', enc.encode(patchAsm))) === 'patch', 'single .asm: a patch');
check(kinds(inspectUpload('marker.asm', enc.encode(uberAsm))) === 'uberasm', 'single .asm: UberASM code');
check(kinds(inspectUpload('solid.asm', enc.encode(blockAsm))) === 'block', 'single .asm: a block');
check(kinds(inspectUpload('Square Test.zip', testSongZip())) === 'music', 'AddmusicK song');
const two = inspectUpload('two.zip', zip({ 'a.asm': patchAsm, 'b.asm': patchAsm.replace('A1DA', 'A1DB') }));
check(two.status === 'ready' && two.parts[0].kind === 'patch' && two.parts[0].candidates.length === 2, 'two patch files: one patch, its main file to choose');

// two misc sprites in one folder: each its own part (the folder goes with both)
const misc = 'print "MAIN ",pc\n  RTL\n';
check(kinds(inspectUpload('Two.zip', zip({ 'cluster/a.asm': misc, 'cluster/b.asm': misc, 'readme.txt': 'x' }))) === 'sprite sprite', 'two sprites in one folder: two parts');

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

// graphics without code and without a .mwl: a package of graphics parts
const tilesOnly = inspectUpload('Tiles.zip', zip({ 'Tiles.map16': unzipSync(fixture('RockClimbBlocksUpdate.zip'))['Tiles.map16'], 'ExGFX80_BG2.bin': new Uint8Array(0x1000) }));
check(kinds(tilesOnly) === 'graphics graphics', `graphics only: a package (${kinds(tilesOnly)})`);

const junk = inspectUpload('stuff.zip', zip({ 'readme.txt': 'hello', 'pic.png': new Uint8Array(30) }));
check(junk.status === 'failed' && /2 files/.test(junk.reason) && /\.png/.test(junk.reason) && /no \.asm/.test(junk.reason), `unrecognizable: says what was found and what is missing (${junk.status === 'failed' ? junk.reason : junk.status})`);

// ---------- install, remove, undo ----------

const rom = new Rom(EDITOR_IMAGE.slice());
const emu = new LevelEmulator(rom); emu.boot();
const src = map16Source(rom, emu.load(0x105));
const opts: InstallOptions = { level: 0x105, blank: src.fg(0x025), tileWords: (t) => src.fg(t) };
installEditorPatch(rom);
enableBlocks(rom, opts.blank); // the Map16 extension with custom blocks enabled
setLevelMusic(rom, 0x105, 1); setLevelMusic(rom, 0x105, 0); // the patch for music set per level (stays)
const vanilla = rom.data.slice();
const sameRom = (what: string) => {
  // the checksum (rewritten by AddmusicK) and the ROM size byte don't count
  const diff = romDiff(rom.data, vanilla, (i) => i === 0x7fd7 || (i >= 0x7fdc && i < 0x7fe0));
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
check(r1.ok && listPackages(rom).length === 1 && r1.pkg!.patches.length === 1 && r1.pkg!.uberasm.calls.length === 1, 'installed as one package with its patch and UberASM call');
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

// two packages bringing an identical sprite file: removing the first keeps it for the second
{
  const sprite = 'print "MAIN ",pc\n  RTL\n';
  const sa = await install(inspectUpload('SA.zip', zip({ 'cluster/shared.asm': sprite, 'readme.txt': 'A' })));
  const sb = await install(inspectUpload('SB.zip', zip({ 'cluster/shared.asm': sprite, 'cluster/own.asm': sprite, 'readme.txt': 'B' })));
  check(sa.ok && sb.ok && sb.pkg!.sprite.files.includes('cluster/shared.asm'), `SB's record has the shared sprite file (${sb.pkg?.sprite.files.join()})`);
  await removePackage(rom, sa.pkg!.id, opts.blank);
  const pp = loadPixiProject(rom);
  check(!!pp?.files.has('cluster/shared.asm') && pp.files.has('cluster/own.asm'), 'removing SA keeps the sprite file SB uses');
  await removePackage(rom, sb.pkg!.id, opts.blank);
}

// its file assigned by hand elsewhere (all levels) and its own assignment dropped: removing it takes
// the hand-made assignment along instead of leaving a call to a missing file
{
  const r = await install(inspectUpload('C.zip', zip({ 'level/c.asm': 'main:\n  RTL\n' })));
  const p = loadProject(rom)!;
  p.list.level.delete(0x105);
  p.list.level.set(ALL, [{ file: 'level/c.asm', bytes: [] }]);
  saveProject(rom, p);
  const rm = await removePackage(rom, r.pkg!.id, opts.blank);
  const after = loadProject(rom);
  check(r.ok && !rm.length && !after?.files.has('level/c.asm') && !after?.list.level.has(ALL), 'removing a package drops hand-made assignments of its files ' + rm.join(' | '));
}

// manuals: the tool tabs list those of the installed packages, so they come and go with the package
// (and its undo, which restores ROM and editor data)
{
  const withDocs = await install(inspectUpload('Docs.zip', zip({ 'level/d.asm': 'main:\n  RTL\n', 'readme.txt': 'How to use D' })));
  const without = await install(inspectUpload('NoDocs.zip', zip({ 'level/n.asm': 'main:\n  RTL\n' })), { level: 0x106 });
  const names = (tool: ToolKind) => packageManuals(rom, tool).map((m) => m.pkg.name).join();
  check(withDocs.ok && without.ok && names('uberasm') === 'Docs' && !names('block') && !names('sprite'), `manuals: only the package with a readme, in the UberASM tab (${names('uberasm')})`);
  check(packageManuals(rom, 'uberasm')[0]?.files.has('readme.txt') === true, 'manuals: with the package files');
  const before = rom.snapshot();
  await removePackage(rom, withDocs.pkg!.id, opts.blank);
  check(!names('uberasm'), 'manuals: gone with the package');
  rom.restore(before);
  check(names('uberasm') === 'Docs', 'manuals: back when the removal is undone');
  for (const r of [withDocs, without]) await removePackage(rom, r.pkg!.id, opts.blank);
}

// sprites and blocks
const rb = await install(bill);
check(rb.ok && loadPixiProject(rom)!.list.length === 2, 'Brutal Bill: sprite and shooter in the PIXI project');
const rr = await install(rock, { level: null }); // with a level, its graphics slots would be set (they stay)
check(rr.ok && loadBlockProject(rom)!.list.length === 2, 'Rock Climb Blocks: two blocks on Map16 tiles');
const rs = await install(shatter, { level: null }); // with a level, the VRAM patch for its BG3 graphics (it stays)
check(rs.ok && loadPixiProject(rom)!.list.some((e) => e.kind === 'bounce'), 'Aftertouch Shatter: its bounce sprite');
// On-Off Blocks: the block on both tiles of its .map16, its bounce sprite's number in the block
const ro = await install(onoff, { level: null });
{
  const sprite = loadPixiProject(rom)?.list.find((e) => e.kind === 'bounce' && /on_off_block/.test(e.file));
  const block = dec.decode(loadBlockProject(rom)?.files.get('blocks/on_off_block.asm'));
  const num = /^!bounce_num\s*=\s*\$([0-9A-F]+)/im.exec(block)?.[1];
  check(ro.ok && ro.pkg!.block.tiles.length === 2 && ro.pkg!.map16!.length === 2 && ro.pkg!.gfx.length === 0, `On-Off Blocks: block on two Map16 tiles, no ExGFX (its only file is AN2, animation frames) (${ro.prints.join(' | ')})`);
  check(!!sprite && num !== undefined && parseInt(num, 16) === sprite.num, `On-Off Blocks: the block spawns bounce sprite ${sprite?.num.toString(16)} (!bounce_num = $${num})`);
}
for (const r of [ro, rs, rr, rb, r1]) await removePackage(rom, r.pkg!.id, opts.blank);
sameRom('all removed');

// tool folders
for (const [p, what] of [[uberFolder, 'UberASM Tool folder'], [gpsFolder, 'GPS folder'], [pixiFolder, 'PIXI folder']] as const) {
  const r = await install(p);
  check(r.ok && listPackages(rom).length === 1, `${what}: installed as one package`);
  await removePackage(rom, r.pkg!.id, opts.blank);
}
sameRom('tool folders removed');

// No Overworld (UberASM Tool 2.0): three game mode files, each including the same file of defines and
// macros (with a hijack) – each resource assembled on its own, as in UberASM Tool; the game modes from
// the readme's list.txt lines
{
  const r = await install(inspectUpload('No Overworld v1.3.zip', fixture('No Overworld v1.3.zip')));
  const modes = r.pkg?.uberasm.calls.map(([ctx, num, f]) => `${ctx} ${num.toString(16)} ${f.replace(/^.*_/, '')}`).join(', ');
  check(r.ok && modes === 'gamemode c gm0C.asm, gamemode 10 gm10.asm, gamemode 14 gm14.asm', `No Overworld: installed, game modes from the readme (${modes})`);
  check([...rom.data.slice(0x25c64, 0x25c67)].every((b) => b === 0xea), 'No Overworld: its hijack (NOP #3 at $04DC64)');
  await removePackage(rom, r.pkg!.id, opts.blank);
}
sameRom('No Overworld removed');

// graphics only: Map16 tiles and ExGFX recorded, removed with the package
{
  const r = await install(tilesOnly, { level: null });
  check(r.ok && r.pkg!.map16!.length === 2 && r.pkg!.gfx.length === 1, 'graphics only: Map16 tiles and ExGFX installed as one package');
  await removePackage(rom, r.pkg!.id, opts.blank);
}
sameRom('graphics removed');

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
  check(r.ok && !!r.pkg && r.pkg.uberasm.calls.length === 1 && listPackages(rom).length === 1, 'Retry installed as one package ' + r.errors.slice(0, 2).join(' | '));
  if (r.ok) {
    // falling into a pit: Retry respawns Mario in the level (vanilla: game over with 0 lives)
    const e = new LevelEmulator(rom); e.boot();
    const p = PlaySession.start(e, 0x105);
    const t = e.snes;
    p.play(30);
    t.wram[0x96] = 0xf0; t.wram[0x97] = 0x01;
    const modes: number[] = [];
    for (let i = 0; i < 400; i++) {
      p.frame(i > 200 && i <= 204 ? PAD.a : 0);
      if (modes[modes.length - 1] !== p.mode) modes.push(p.mode);
    }
    check(p.ready && modes.includes(0x0f) && modes[modes.length - 1] === GM.level && !modes.includes(0x15), `in the emulator: Retry respawns in the level (game modes ${modes.map((m) => m.toString(16)).join(' ')})`);
    await removePackage(rom, r.pkg!.id, opts.blank);
  }
  const nothing = await installPackage(rom, retry, { ...opts, assignment: { rules: new Map([['', null]]), calls: [] } });
  check(!nothing.ok && /Nothing/i.test(nothing.errors[0] ?? ''), 'an assignment taking nothing: error');
}

// configuration views: unassigning everything keeps the content, so it can be assigned again
{
  const rb2 = await install(bill), rr2 = await install(rock, { level: null }), ru = await install(mixed);
  const pp = loadPixiProject(rom)!, sprites = pp.list;
  const unP = savePixiProject(rom, { ...pp, list: [] });
  const bp = loadBlockProject(rom)!, blocks = bp.list;
  const unB = saveBlockProject(rom, { ...bp, list: [] });
  const up2 = loadProject(rom)!, calls = new Map(up2.list.level);
  up2.list.level.clear();
  const unU = saveProject(rom, up2);
  check(unP.ok && unB.ok && unU.ok, 'everything unassigned ' + [...unP.errors, ...unB.errors, ...unU.errors].join(' '));
  check(loadPixiProject(rom)?.files.size === pp.files.size && loadBlockProject(rom)?.files.size === bp.files.size && loadProject(rom)?.files.size === up2.files.size,
    'the files stay in the projects');
  const reP = savePixiProject(rom, { ...loadPixiProject(rom)!, list: sprites });
  const reB = saveBlockProject(rom, { ...loadBlockProject(rom)!, list: blocks });
  const up3 = loadProject(rom)!; up3.list.level = calls;
  const reU = saveProject(rom, up3);
  check(reP.ok && reB.ok && reU.ok && loadPixiProject(rom)!.list.length === 2 && loadBlockProject(rom)!.list.length === 2, 'assigned again');
  for (const r of [ru, rr2, rb2]) await removePackage(rom, r.pkg!.id, opts.blank);
  check(!listPackages(rom).length && !loadPixiProject(rom) && !loadBlockProject(rom), 'and removed with their packages');
}

// the level setup (a level edit, on its own ROM): On-Off Blocks' masked colors in level 105's palette;
// removing the package keeps them. Unchecked: the level stays as it was.
{
  const rom = new Rom(EDITOR_IMAGE.slice());
  const e = new LevelEmulator(rom); e.boot();
  const l = e.load(0x105);
  const s = map16Source(rom, l);
  const o: InstallOptions = { level: 0x105, blank: s.fg(0x025), tileWords: (t) => s.fg(t), cgram: levelColors(l) };
  const pal = onoff.status === 'ready' ? onoff.files.get('PinkThreeCols.pal')! : new Uint8Array();
  const want = (i: number) => (pal[i * 3] >> 3) | ((pal[i * 3 + 1] >> 3) << 5) | ((pal[i * 3 + 2] >> 3) << 10);
  const off = await installPackage(rom, ready(onoff), { ...o, setup: false });
  check(off.ok && !customPalette(rom, 0x105), 'level setup unchecked: level 105 keeps its colors');
  await removePackage(rom, off.pkg!.id, o.blank);
  const r = await installPackage(rom, ready(onoff), o);
  const e2 = new LevelEmulator(rom); e2.boot();
  const cg = e2.load(0x105).cgram;
  const row7 = Array.from({ length: 9 }, (_, i) => cg[(0x70 + i) * 2] | (cg[(0x70 + i) * 2 + 1] << 8));
  const other = cg[0x12] | (cg[0x13] << 8), before = l.cgram[0x12] | (l.cgram[0x13] << 8);
  check(r.ok && row7.every((c, i) => c === want(0x70 + i)) && other === before, `level setup: palette row 7 from PinkThreeCols.pal in the level, other colors kept (${r.prints.filter((p) => /color/.test(p)).join()})`);
  await removePackage(rom, r.pkg!.id, o.blank);
  check(!!customPalette(rom, 0x105), 'removing the package keeps the level setup');
}

// the level setup with Lunar Magic's AN2 and ExAnimation (on its own ROM): the sample level's two
// ExAnimation slots for tiles 200-207 come into the list of level 105, their frames from On-Off Blocks'
// ExGFX291 (AN2) copied into Anim graphic A; in the game the block's tiles show them by the ON/OFF switch
{
  const rom = new Rom(EDITOR_IMAGE.slice());
  const e = new LevelEmulator(rom); e.boot();
  const l = e.load(0x105);
  const s = map16Source(rom, l);
  const r = await installPackage(rom, ready(onoff), { level: 0x105, blank: s.fg(0x025), tileWords: (t) => s.fg(t), cgram: levelColors(l), wram: l.wram });
  const an2 = onoff.status === 'ready' ? onoff.files.get('ExGraphics/ExGFX291.bin')! : new Uint8Array();
  const list = readLevelList(rom, 0x105);
  const alt = readAltFile(rom, 0);
  check(r.ok && list?.slots.size === 2 && [...list.slots.values()].every((x) => x.trigger === 3 && usesAltFile(x)) && alt?.length === 0x200,
    `level setup: 2 ExAnimation slots in level 105, their 16 frame tiles (AN2 and GFX33 from RAM) in Anim graphic A (${alt?.length}; ${r.prints.filter((p) => /Level 105/.test(p)).join(' | ')})`);
  const lv = loadLevel(rom, 0x105);
  lv.objects.push({ uid: newUid(), num: 0, ext: DM16_EXT, x: 4, y: 20, size: 0x00, tile: r.pkg!.block.tiles[0] });
  saveLevel(rom, lv);
  const vramAt = (sw: number) => {
    const e2 = new LevelEmulator(rom); e2.boot();
    e2.load(0x105, { onOffSwitch: sw === 1 });
    for (let i = 0; i < 16; i++) e2.snes.runFrame();
    return e2.snes.vram;
  };
  const same = (v: Uint8Array, at: number, from: number) => an2.subarray(from, from + 0x80).every((x, i) => v[at + i] === x);
  const on = vramAt(0), off = vramAt(1);
  check(same(on, 0x2040 * 2, 0x80) && !same(on, 0x2000 * 2, 0), 'switch ON: tiles 204-207 from AN2 tiles 4-7');
  check(same(off, 0x2000 * 2, 0) && !same(off, 0x2040 * 2, 0x80), 'switch OFF: tiles 200-203 from AN2 tiles 0-3');
}

// the sample level (a level edit, on its own ROM): On-Off Blocks' SampleLevel.mwl in place of level 105 –
// Lunar Magic's Direct Map16 objects become the editor's, on the tiles the block went to; the .map16
// lands where the author had it (508, the column from the sample level); bumping a block from below
// flips the ON/OFF switch – also after a song is installed (AddmusicK runs the game in the FastROM banks
// $80+, the block's caller is still found) and after an older Map16 extension is brought up to date
{
  const rom = new Rom(EDITOR_IMAGE.slice());
  const e = new LevelEmulator(rom); e.boot();
  const l = e.load(0x105);
  const s = map16Source(rom, l);
  const into = loadLevel(rom, 0x105);
  const r = await installPackage(rom, ready(onoff), { level: 0x105, blank: s.fg(0x025), tileWords: (t) => s.fg(t), cgram: levelColors(l), wram: l.wram, sample: into });
  const lv = r.sample?.level;
  const dm = lv?.objects.filter((o) => o.tile !== undefined) ?? [];
  check(r.ok && !!lv && dm.map((o) => `${o.x},${o.y}:${o.tile!.toString(16)}`).sort().join(' ') === '6,20:508 9,20:509' && r.pkg!.block.tiles.join() === [0x508, 0x509].join(),
    `sample level: its blocks on tiles 508/509, where the block went (${dm.map((o) => `${o.x},${o.y}:${o.tile!.toString(16)}`).join(' ')}; ${r.warnings.join(' | ')})`);
  const keys = [...(readLevelList(rom, 0x105)?.slots.keys() ?? [])].sort((a, b) => a - b).join();
  check(keys === '0,8', `sample level: its ExAnimation list in place of the level's (slots ${keys})`);
  // Mario under the block at (6, 20), jumping: whether the ON/OFF switch flips
  const bump = (what: string): void => {
    const e2 = new LevelEmulator(rom); e2.boot();
    const p = PlaySession.start(e2, 0x105);
    const w = p.wram;
    const at = (x: number, y: number) => w[0xc800 + (x >> 4) * 0x1b0 + y * 16 + (x & 15)] | (w[0x1c800 + (x >> 4) * 0x1b0 + y * 16 + (x & 15)] << 8);
    check(p.ready && at(6, 20) === 0x508 && at(9, 20) === 0x509, `${what} in the game: tiles ${at(6, 20).toString(16)} ${at(9, 20).toString(16)}`);
    const sw = w[0x14af];
    for (let i = 0; i < 40; i++) { w[0x94] = 6 * 16; w[0x95] = 0; p.frame(); }
    w[0x96] = (22 * 16) & 0xff; w[0x97] = (22 * 16) >> 8; w[0x7d] = 0xb0; w[0x72] = 0x0b;
    let flipped = false;
    for (let i = 0; i < 40 && !flipped; i++) { p.frame(); if (w[0x14af] !== sw) flipped = true; }
    check(flipped, `${what}: bumping the block flips the ON/OFF switch (${sw} → ${w[0x14af]})`);
  };
  if (lv) {
    saveLevel(rom, lv);
    bump('sample level');
    const rm = await installPackage(rom, ready(inspectUpload('Square Test.zip', testSongZip())), { level: null, blank: s.fg(0x025), tileWords: (t) => s.fg(t) });
    check(rm.ok && rom.r24(0x008076) >> 16 === 0x8e, `a song installed: AddmusicK's main loop at $008075 enters $8E (${rm.warnings.join(' | ')})`);
    bump('with AddmusicK');
  }
}

// the sample level follows the blocks when the author's tiles are taken
{
  const rom = new Rom(EDITOR_IMAGE.slice());
  const e = new LevelEmulator(rom); e.boot();
  const s = map16Source(rom, e.load(0x105));
  setExtTileWords(rom, 0x508, s.fg(0x130));
  const r = await installPackage(rom, ready(onoff), { level: null, blank: s.fg(0x025), tileWords: (t) => s.fg(t), sample: loadLevel(rom, 0x105) });
  const tiles = (r.sample?.level.objects ?? []).filter((o) => o.tile !== undefined).map((o) => o.tile!).sort((a, b) => a - b);
  check(r.ok && tiles.join() === r.pkg!.block.tiles.slice().sort((a, b) => a - b).join() && !tiles.includes(0x508), `508 taken: the sample level's blocks on ${tiles.map((t) => t.toString(16)).join(', ')}`);
}

// Lunar Magic's Direct Map16 objects: 22/23 (page 0/1), 27 with one tile, a block of tiles, a block
// repeated over a rectangle and over screens
{
  const notes: string[] = [];
  const data = Uint8Array.from([
    0x45, 0x23, 0x10, 0x30, // 22 at (3, 5): tile 030, 1x2
    0x46, 0x34, 0x00, 0x2a, // 23 at (4, 6): tile 12A
    0x47, 0x75, 0x21, 0x05, 0x08, // 27 fmt 0 at (5, 7): tile 508, 3x2
    0x48, 0x76, 0x11, 0x45, 0x08, // 27 fmt 1 at (6, 8): 2x2 tiles from 508
    0x49, 0x77, 0x13, 0x85, 0x08, 0x01, // 27 fmt 2 at (7, 9): 2x4 of 1x2 tiles from 508
    0x4a, 0x78, 0x02, 0xc5, 0x08, 0x00, 0x00, // 27 fmt 3 at (8, 10): 1x3 of tile 508
    0x4b, 0xd9, 0x00, 0x00, 0x00, // 2D (custom): left out
    0xff]);
  const { objects } = parseLmObjects(data, 0, false, notes);
  const d = objects.map((o) => `${o.x},${o.y}:${o.tile?.toString(16)}/${o.size.toString(16)}`).join(' ');
  check(d === '3,5:30/10 4,6:12a/0 5,7:508/21 6,8:508/0 7,8:509/0 6,9:518/0 7,9:519/0 7,9:508/0 8,9:509/0 9,9:508/0 10,9:509/0 7,10:508/0 8,10:509/0 9,10:508/0 10,10:509/0 8,10:508/0 9,10:508/0 10,10:508/0'
    && notes.some((n) => /2D/.test(n)), `Direct Map16 objects converted (${d}; ${notes.join(' | ')})`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
