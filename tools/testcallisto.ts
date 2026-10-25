// Callisto projects (core/callisto.ts): the Romhack Races baserom (test/fixtures/rhr-baserom-5.15.zip)
// uploads as one package – its patches in patches.toml's order (the two replaced patches left out with a
// note), its UberASM Tool and GPS folders with their lists from setup/lists/, Callisto's initial patch
// and Lunar Magic BPS left out with a note – and installs: the patches in that order, the UberASM files and GPS blocks including callisto.asm
// built, the game still plays. A small made-up project shows the generated header (defines, macros, the
// project's callisto_header) in a patch, UberASM code and a block, the defines Callisto passes to
// patches, and removing the package. A lone file including callisto.asm is refused.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { loadApu } from '../src/core/apu.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { enableBlocks } from '../src/core/map16ext.ts';
import { inspectUpload, installPackage, removePackage, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { parseToml, callistoAsm } from '../src/core/callisto.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { loadProject } from '../src/core/uberproject.ts';
import { loadBlockProject } from '../src/core/blocks.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { editorImage, romDiff } from './fixture.ts';

await loadAsar();
await loadApu();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();
const dec = new TextDecoder();
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v])));
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1).replace(/\.asm$/, '');

// an opened ROM with the Map16 extension and custom blocks, and the options to install into level 105
async function target(): Promise<{ rom: Rom; opt: InstallOptions }> {
  const rom = new Rom(await editorImage());
  const emu = new LevelEmulator(rom); emu.boot();
  const src = map16Source(rom, emu.load(0x105));
  const blank = src.fg(0x025);
  installEditorPatch(rom);
  enableBlocks(rom, blank);
  return { rom, opt: { level: 0x105, blank, tileWords: (t) => src.fg(t), setup: false } };
}

// ---------- the configuration ----------

{
  const t = parseToml(`# comment\n[a]\n  x = "{v}/p.asm" # after\n  list = [\n    "one", # c\n    'two',\n  ]\n[b.c]\nn = 3\nflag = true\nt = { k = "v" }\n`);
  check(t.get('a.x') === '{v}/p.asm' && JSON.stringify(t.get('a.list')) === '["one","two"]' && t.get('b.c.n') === 3 && t.get('b.c.flag') === true && t.get('b.c.t') === null, 'TOML: tables, strings, arrays over lines, numbers, booleans, comments');
}

// ---------- the Romhack Races baserom ----------

const baserom = new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip'));
// patches.toml's patches but the replaced ones (the GFX load optimization and the sprite scroll fix, replaced.ts)
const order = (files: Record<string, Uint8Array>) => [...dec.decode(files['tools/Callisto/patches.toml']).matchAll(/"\{patches_folder\}\/([^"]+)"/g)]
  .map((m) => 'resources/patches/' + m[1]).filter((f) => !/level_gfxload_optimization|sprite_scroll_fix/.test(f));
{
  const p = ready(inspectUpload('rhr-baserom-5.15.zip', baserom));
  const files = unzipSync(baserom);
  const patches = p.parts.filter((x) => x.kind === 'patch').map((x) => x.file);
  check(!!p.callisto && patches.length === 86 && patches.join() === order(files).join(), `one package, its 86 patches in patches.toml's order (${patches.length})`);
  check(p.parts.some((x) => x.kind === 'uberasm' && x.file === 'tools/UberASMTool/gamemode/retry_gm.asm' && x.folder?.list.gamemode.size === 6), 'its UberASM Tool folder, the list from setup/lists/');
  const blocks = p.parts.filter((x) => x.kind === 'block');
  check(blocks.length === 77 && blocks.every((b) => b.file.startsWith('tools/GPS/blocks/')), `its GPS blocks, those of setup/lists/list_gps.txt (${blocks.length})`);
  check(p.parts.filter((x) => x.kind === 'sprite').map((x) => x.file).join() === 'tools/PIXI/sprites/donut_sprite.cfg', 'its PIXI sprite');
  const left = ['resources/initial_patches/fastrom.bps', 'export/global/overworld.bps', 'export/global/titlescreen.bps', 'export/global/credits.bps'];
  check(left.every((f) => p.notes.some((n) => n.includes(f)) && !p.unclaimed.includes(f)), 'initial patch, overworld, title screen and credits left out with a note:\n       ' + p.notes.join('\n       '));
  const h = callistoAsm(p.callisto!);
  check(h.includes('!CALLISTO_VERSION = "0.6.2"') && h.includes('!CALLISTO_VERSION_PATCH = 2') && h.includes('!CALLISTO_HEADER = "/shared/headers/callisto.asm"') && h.includes('macro import_library') === false,
    'callisto.asm: the version the project pins (0.6.2), its callisto_header');
}

// installs – with its Map16 (testrommap16.ts) and global animation (testglobalanim.ts), without what other
// issues of #96 bring: the other graphics (#99, #107) and the sample levels (#101)
{
  const files = unzipSync(baserom);
  const keep: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) if (!/^(export\/(?!all_map16\.map16$|global\/exanimation\.bps$)|resources\/(palettes|original_graphics)\/|workspace\/(?!ExGraphics\/ExGFX61\.bin$))/.test(k)) keep[k] = v;
  const p = ready(inspectUpload('baserom.zip', zip(keep)));
  const { rom, opt } = await target();
  const before = listPatches(rom).length;
  const r = await installPackage(rom, p, opt);
  if (!r.ok) console.log(r.errors.slice(0, 5).join('\n'));
  const reg = listPatches(rom).slice(before).map((x) => x.name);
  const want = order(keep).map(base);
  check(r.ok && reg.slice(0, want.length).join() === want.join(), `installed, its ${want.length} patches applied in patches.toml's order`);
  const pkg = listPackages(rom);
  // the 140 tiles of its GPS list and the 65 more of its Map16 acting like them
  check(pkg.length === 1 && pkg[0].patches.length === want.length && pkg[0].uberasm.calls.length === 9 && pkg[0].block.tiles.length === 205 && pkg[0].sprite.files.length > 0
    && pkg[0].map16?.length === 956 && pkg[0].bgMap16?.length === 100 && pkg[0].globalAnim?.slots.length === 7,
    `one package: the patches, the UberASM calls, the block tiles, the sprite, the Map16 tiles, the global animation (${pkg[0]?.block.tiles.length} block tiles, ${pkg[0]?.map16?.length} FG, ${pkg[0]?.bgMap16?.length} BG, ${pkg[0]?.globalAnim?.slots.length} slots)`);
  const uber = loadProject(rom);
  const gm = uber?.list.gamemode;
  check(!!uber?.files.has('callisto.asm') && !!uber.files.has('callisto/shared/freeram.asm') && gm?.get(0x14)?.some((c) => c.file === 'gamemode/screen_scrolling_pipes.asm') === true && gm.get(-1)?.[0].file === 'gamemode/retry_gm.asm',
    'UberASM built: its code including callisto.asm, Retry in every game mode');
  const gps = loadBlockProject(rom);
  const pipes = gps?.list.filter((b) => /pipe_cap|pass_if_in_pipe|turn_/.test(b.file)) ?? [];
  check(!!gps?.files.has('callisto.asm') && pipes.length > 20 && gps.list.length === 205, `GPS built: ${gps?.list.length} tiles, ${pipes.length} of them screen scrolling pipes (including callisto.asm)`);
  const emu = new LevelEmulator(rom); emu.boot();
  emu.load(0x105);
  const s = emu.snes;
  let g = 0; while (s.wram[0x100] !== 0x14 && g++ < 200) s.runFrame();
  const x0 = s.wram[0x94] | (s.wram[0x95] << 8);
  for (let f = 0; f < 120; f++) { s.joy1 = 0x0100; s.runFrame(); }
  const x1 = s.wram[0x94] | (s.wram[0x95] << 8);
  check(s.wram[0x100] === 0x14 && x1 > x0 + 32, `the game plays: level 105, Mario runs right (${x0} → ${x1})`);
  // its ON/OFF blocks' tiles (2F0–2FF) show the ON frame of ExGFX61.bin
  emu.load(0x105);
  const on = emu.animationFrames(4, 8).at(-1)!.vram.subarray(0x2f0 * 32, 0x300 * 32);
  check(on.every((b, i) => b === files['workspace/ExGraphics/ExGFX61.bin'][0xc00 + i]), 'its global animation runs: the ON/OFF blocks\' tiles show the ON frame');
}

// ---------- a made-up project: the header in a patch, UberASM code and a block ----------

const mini: Record<string, string> = {
  'tools/Callisto/project.toml': '[settings]\nproject_root = "../../"\n',
  'tools/Callisto/variables.toml': '[variables]\nshared_folder = "lib"\npatches_folder = "asm"\ntools_folder = "tools"\n',
  'tools/Callisto/modules.toml': '[resources]\ncallisto_header = "{shared_folder}/header.asm"\n',
  'tools/Callisto/patches.toml': '[resources]\npatches = [\n  "{patches_folder}/second.asm",\n  "{patches_folder}/first.asm",\n]\n',
  'tools/Callisto/tools.toml': '[tools.generic.UberASM]\ndirectory = "{tools_folder}/UberASMTool"\nexecutable = "UberASMTool.exe"\n[tools.generic.GPS]\ndirectory = "{tools_folder}/GPS"\nexecutable = "gps.exe"\n',
  'tools/Callisto/build.toml': '[resources]\ninitial_patch = "resources/initial_patches/sa1.bps"\n',
  'lib/header.asm': 'macro import_library(path)\n  %incsrc_file("lib/<path>")\nendmacro\n',
  'lib/ram.asm': '!marker = $7FB040\n',
  // second.asm first: it prints what the header and Callisto give it
  'asm/second.asm': 'incsrc "callisto.asm"\n%require_callisto_version(0, 6, 0)\n%import_library("ram.asm")\nprint "!CALLISTO_INSERTION_TYPE !CALLISTO_ASSEMBLING !CALLISTO_VERSION"\nprint hex(!marker)\norg $00A1DA\n  db $EA\n',
  'asm/first.asm': 'incsrc "callisto.asm"\norg $00A1DB\n  db $EA\n',
  'tools/UberASMTool/gamemode/mark.asm': 'incsrc "callisto.asm"\n%import_library("ram.asm")\nmain:\n  LDA #$5A : STA !marker\n  RTL\n',
  'lists/list_uberasm.txt': 'gamemode:\n14 mark.asm\n',
  'tools/GPS/blocks/solid.asm': `incsrc "callisto.asm"\n%import_library("ram.asm")\ndb $42\n${Array(10).fill('JMP Code').join(' : ')}\nCode:\n  LDA #$01 : STA !marker\n  RTL\n`,
  'lists/list_gps.txt': '2C0 solid.asm\n',
  'resources/initial_patches/sa1.bps': 'BPS1',
};
{
  const p = ready(inspectUpload('mini.zip', zip(mini)));
  check(p.parts.filter((x) => x.kind === 'patch').map((x) => x.file).join() === 'asm/second.asm,asm/first.asm', 'patches in patches.toml\'s order, not by name');
  check(p.notes.length === 1 && p.notes[0].includes('sa1.bps'), 'the initial patch left out: ' + p.notes.join(' '));
  check(p.callisto!.version.join('.') === '0.6.2', 'no version pinned: the one followed, 0.6.2');
  const pinned = ready(inspectUpload('pinned.zip', zip({ ...mini, 'setup/tools.json': '{"url": "https://github.com/Underrout/callisto/releases/download/v0.7.1/callisto-v0.7.1.zip"}' })));
  check(callistoAsm(pinned.callisto!).includes('!CALLISTO_VERSION = "0.7.1"'), 'the version the setup downloads: 0.7.1');
  const { rom, opt } = await target();
  const vanilla = rom.data.slice();
  const r = await installPackage(rom, p, opt);
  if (!r.ok) console.log(r.errors.join('\n'));
  check(r.ok && r.prints[0] === 'Patch 1 0.6.2' && r.prints[1] === '7FB040', `a patch gets Callisto's defines and the header's macros (${r.prints.slice(0, 2).join(' | ')})`);
  check(!!loadProject(rom)?.files.has('callisto/lib/ram.asm') && loadBlockProject(rom)?.list[0]?.tile === 0x2c0, 'UberASM code and the block including callisto.asm built');
  // the UberASM code runs in game mode 14 and writes where the project's header says
  const emu = new LevelEmulator(rom); emu.boot();
  emu.load(0x105);
  for (let f = 0; f < 30; f++) emu.snes.runFrame();
  check(emu.snes.wram[0x1b040] === 0x5a, 'the UberASM code runs: $7FB040 = $5A');
  const warnings = await removePackage(rom, r.pkg!.id, opt.blank);
  check(!listPackages(rom).length && romDiff(vanilla, rom.data) === 0, 'removed: the ROM as before ' + warnings.join(' '));
}

// ---------- a file of a Callisto project on its own ----------

{
  const lone = inspectUpload('fix.asm', enc.encode('incsrc "callisto.asm"\norg $00A1DA\n  db $EA\n'));
  check(lone.status === 'failed' && lone.reason.includes('part of a Callisto project') && lone.reason.includes('upload the whole project'), 'a lone patch including callisto.asm: ' + (lone.status === 'failed' ? lone.reason : lone.status));
  const withOwn = inspectUpload('own.zip', zip({ 'fix.asm': 'incsrc "callisto.asm"\norg $00A1DA\n  db $EA\n', 'callisto.asm': '!x = 1\n' }));
  check(withOwn.status === 'ready', 'one bringing its own callisto.asm is an ordinary patch');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
