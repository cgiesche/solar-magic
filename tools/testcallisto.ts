// Callisto projects (core/callisto.ts): the Romhack Races baserom (test/fixtures/rhr-baserom-5.15.zip)
// uploads as one package – its patches in patches.toml's order (the three replaced patches left out with a
// note), its UberASM Tool and GPS folders with their lists from setup/lists/, Callisto's initial patch
// and Lunar Magic BPS left out with a note – and installs: the patches in that order, the UberASM files and GPS blocks including callisto.asm
// built, the game still plays. A small made-up project shows the generated header (defines, macros, the
// project's callisto_header) in a patch, UberASM code and a block, the defines Callisto passes to
// patches, and removing the package. A lone file including callisto.asm is refused.
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync } from 'fflate';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { Apu, loadApu } from '../src/core/apu.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { PPU } from '../src/core/ppu.ts';
import { GM, PAD } from '../src/core/ram.ts';
import { PlaySession } from '../src/core/playsession.ts';
import { OverworldEmulator } from '../src/core/overworld.ts';
import { map16Source } from '../src/core/render.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { enableBlocks } from '../src/core/map16ext.ts';
import { inspectUpload, installPackage, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { parseToml, callistoAsm } from '../src/core/callisto.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { loadProject } from '../src/core/uberproject.ts';
import { loadBlockProject } from '../src/core/blocks.ts';
import { listPackages, uninstallPackage } from '../src/core/pkgreg.ts';
import { loadMusicProject, hasAmk } from '../src/core/music.ts';
import { loadPixiProject } from '../src/core/pixi.ts';
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
// patches.toml's patches but the replaced ones (the GFX load optimization, the sprite scroll fix and the VRAM
// Patch optimization, replaced.ts)
const order = (files: Record<string, Uint8Array>) => [...dec.decode(files['tools/Callisto/patches.toml']).matchAll(/"\{patches_folder\}\/([^"]+)"/g)]
  .map((m) => 'resources/patches/' + m[1]).filter((f) => !/level_gfxload_optimization|sprite_scroll_fix|vram_optimize/.test(f));
{
  const p = ready(inspectUpload('rhr-baserom-5.15.zip', baserom));
  const files = unzipSync(baserom);
  const patches = p.parts.filter((x) => x.kind === 'patch').map((x) => x.file);
  check(!!p.callisto && patches.length === 85 && patches.join() === order(files).join(), `one package, its 85 patches in patches.toml's order (${patches.length})`);
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
  const ps = PlaySession.start(emu, 0x105);
  const s = emu.snes;
  const x0 = s.wram[0x94] | (s.wram[0x95] << 8);
  ps.play(120, PAD.right);
  const x1 = s.wram[0x94] | (s.wram[0x95] << 8);
  check(ps.ready && ps.mode === GM.level && x1 > x0 + 32, `the game plays: level 105, Mario runs right (${x0} → ${x1})`);
  // Free $7F0000 (free_up_ram.asm) ends $04DD40 with an RTL, which the editor's translevel patch also calls
  check(new OverworldEmulator(rom).load(0, 0).ok, 'the overworld loads (Free $7F0000 with the translevel patch)');
  // a tile the game changes (a coin collected, a block hit) changes on screen: the first solid tile in view
  // made blank by the game's routine ($00BEB0) – its Map16 and how it looks on screen
  {
    const w = s.wram;
    const ppu = s.ppu = new PPU(s);
    for (let f = 0; f < 3; f++) s.runFrame(); // (the scroll registers written)
    const cx = w[0x1a] | (w[0x1b] << 8), cy = w[0x1c] | (w[0x1d] << 8);
    const at = (x: number, y: number) => (x >> 8) * 0x1b0 + (y >> 4) * 16 + ((x >> 4) & 15);
    const tile = (x: number, y: number) => w[0xc800 + at(x, y)] | (w[0x1c800 + at(x, y)] << 8);
    let tx = -1, ty = -1;
    for (let y = (cy + 64) & ~15; y < cy + 192 && tx < 0; y += 16) for (let x = (cx + 32) & ~15; x < cx + 224; x += 16) if (tile(x, y) === 0x3f) { tx = x; ty = y; break; }
    const pic = () => { let p = ''; for (let y = 0; y < 16; y++) p += ppu.frame.subarray((ty - cy - 1 + y) * 256 + tx - cx, (ty - cy - 1 + y) * 256 + tx - cx + 16).join(); return p; };
    const before = pic();
    w[0x9a] = tx & 0xff; w[0x9b] = tx >> 8; w[0x98] = ty & 0xff; w[0x99] = ty >> 8; w[0x9c] = 0x02; // blank
    emu.call(0x00beb0, 0);
    for (let f = 0; f < 3; f++) s.runFrame();
    s.ppu = null;
    check(tx >= 0 && tile(tx, ty) === 0x25 && pic() !== before, `a tile the game changes changes on screen (tile 3F at ${tx},${ty} → ${tile(tx, ty).toString(16)})`);
  }
  // its PIXI sprite at the number its list gives it (A0), which its donut block (29D) spawns: Mario on
  // the block makes it fall, the game goes on
  const donut = loadPixiProject(rom)?.list.find((e) => e.file === 'sprites/donut_sprite.cfg');
  const pd = PlaySession.start(emu, 0x105, { until: 'settled' });
  const feet = (s.wram[0x94] + 8) >> 4 | ((s.wram[0x95] & 0x0f) << 4), row = ((s.wram[0x96] | (s.wram[0x97] << 8)) + 32) >> 4;
  const at = (feet >> 4) * 0x1b0 + row * 16 + (feet & 15);
  s.wram[0xc800 + at] = 0x9d; s.wram[0x1c800 + at] = 0x02;
  let spawned = false, live = 0;
  for (let f = 0; f < 60; f++) {
    pd.frame();
    if (pd.mode === GM.level) live++;
    for (let i = 0; i < 12; i++) if (s.wram[0x14c8 + i] && s.wram[0x7fab9e - 0x7e0000 + i] === 0xa0) spawned = true;
  }
  check(donut?.num === 0xa0 && spawned && live === 60, `its sprite at A0 as list_pixi.txt has it (${donut?.num.toString(16)}): Mario on its donut block spawns it, the game goes on (${live} of 60 frames)`);
  // its ON/OFF blocks' tiles (2F0–2FF) show the ON frame of ExGFX61.bin
  emu.load(0x105);
  const on = emu.animationFrames(4, 8).at(-1)!.vram.subarray(0x2f0 * 32, 0x300 * 32);
  check(on.every((b, i) => b === files['workspace/ExGraphics/ExGFX61.bin'][0xc00 + i]), 'its global animation runs: the ON/OFF blocks\' tiles show the ON frame');
  // its sound effect: Death Prelude of the Retry System, 1DFC 38 as its list says
  const sfx = loadMusicProject(rom)?.sfx ?? [];
  check(pkg[0].sfx?.length === 1 && sfx.length === 1 && sfx[0].bank === '1DFC' && sfx[0].num === 0x38 && sfx[0].name === 'Death Prelude',
    `its sound effect: Death Prelude at 1DFC 38 (${sfx.map((x) => `${x.bank} ${x.num.toString(16)} ${x.name}`).join(', ')})`);
  // dying in a level with Retry's prompt (as its object B1 sets it): the game sends 38 to $1DFC's port as
  // Mario dies and the prompt opens, and the sound effects' voice sounds – much louder than without it
  // (the run again with that write held back; the song's voices muted, which share that voice too)
  const dying = (send: boolean) => {
    const e = new LevelEmulator(rom);
    const apu = e.snes.apu = new Apu();
    const write = apu.write.bind(apu);
    let sent = -1, f = -1;
    apu.write = (t, port, v) => { if (port === 3 && v === 0x38 && f >= 0) { if (sent < 0) sent = f; if (!send) v = 0; } write(t, port, v); };
    e.boot();
    const p = PlaySession.start(e, 0x105);
    const sn = e.snes;
    sn.wram[0x1b411] = 0x02; // !retry_ram_prompt_override ($7FB411): prompt, the death SFX instead of the song
    p.play(30);
    apu.mute(0x7f);
    sn.wram[0x96] = 0xf0; sn.wram[0x97] = 0x01; // into the pit
    let dead = -1, prompt = -1, peak = 0;
    for (f = 0; f < 12; f++) {
      sn.runFrame();
      if (dead < 0 && sn.wram[0x71] === 0x09) dead = f;
      if (prompt < 0 && sn.wram[0x1b40c]) prompt = f; // !retry_ram_prompt_phase
      peak = Math.max(peak, ...sn.audio!.map(Math.abs));
    }
    return { dead, sent, prompt, peak, song: sn.wram[0x1dfb] };
  };
  {
    const d = dying(true), held = dying(false);
    check(d.dead === 0 && d.sent === d.dead && d.prompt === d.dead && d.peak > 2 * held.peak && d.peak > 2000,
      `Mario dies (frame ${d.dead}), the prompt opens (frame ${d.prompt}), Death Prelude plays: 38 sent to $1DFC (frame ${d.sent}), its voice at ${d.peak} (${held.peak} without)`);
  }
  const removed = await uninstallPackage(rom, pkg[0].id, opt.blank);
  check(!hasAmk(rom), `removed with the package: its sound effect, AddmusicK with it ${removed.join(' ')}`);
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
  // (until the level runs, then a few frames)
  const ps = PlaySession.start(emu, 0x105);
  ps.play(5);
  check(ps.ready && emu.snes.wram[0x1b040] === 0x5a, 'the UberASM code runs: $7FB040 = $5A');
  const warnings = await uninstallPackage(rom, r.pkg!.id, opt.blank);
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
