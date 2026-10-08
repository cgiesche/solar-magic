// Packages assigned by hand ("Paket zuordnen"): the suggestion finds UberASM Tool folders inside a package,
// the folders their code includes and list.txt lines quoted in the docs; Retry System (test/fixtures;
// by Kevin/kkevinm) assembled from that suggestion and working in the emulator.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { packageFiles } from '../src/core/patchpkg.ts';
import { suggestMapping, placed, suggestCalls, untaken, docFiles, extraParts } from '../src/core/pkgmap.ts';
import { emptyProject, saveProject } from '../src/core/uberproject.ts';
import { ALL } from '../src/core/uberasm.ts';
import { installEditorPatch } from '../src/core/patches.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();
const fallback = { level: 0x105, gamemode: 0x14, overworld: 0 };

// a package in the shape of Retry System, made up
{
  const files = new Map<string, Uint8Array>(Object.entries({
    'readme.txt': 'Copy the folders.\nAdd to list.txt under level:\n  105 thing_level.asm\nand under gamemode:\n  * a.asm,thing_gm.asm\n',
    'pkg/library/thing.asm': 'incsrc "../thing_cfg/settings.asm"\nrts\n',
    'pkg/level/thing_level.asm': 'init:\nrtl\n',
    'pkg/gamemode/thing_gm.asm': 'main:\nrtl\n',
    'pkg/thing_cfg/settings.asm': 'incsrc "more/x.asm"\n',
    'pkg/thing_cfg/more/x.asm': '!a = 1\n',
    'pkg/unrelated/y.asm': 'nop\n',
    'pkg/unpatch.asm': 'org $008000\n',
    'examples/blocks/b.asm': 'db $42\n',
  }).map(([k, v]) => [k, enc.encode(v)]));
  const s = suggestMapping(files);
  check(!!s && s.root === 'pkg/' && s.rules.get('pkg/library/') === 'library/' && s.rules.get('pkg/thing_cfg/') === 'thing_cfg/' && !s.rules.has('pkg/unrelated/'), 'suggestion: tool folders and the folder their code includes');
  const p = placed(files.keys(), s!.rules);
  check(p.get('pkg/thing_cfg/more/x.asm') === 'thing_cfg/more/x.asm' && p.get('pkg/level/thing_level.asm') === 'level/thing_level.asm' && !p.has('pkg/unrelated/y.asm') && !p.has('readme.txt'), 'placed paths');
  const calls = suggestCalls(files, p, fallback);
  const lv = calls.find((c) => c.ctx === 'level'), gm = calls.find((c) => c.ctx === 'gamemode');
  check(lv?.num === 0x105 && lv.fromDocs && gm?.num === ALL && gm.fromDocs, 'list.txt numbers from the readme (105, * in a list)');
  s!.rules.set('pkg/level/thing_level.asm', null);
  check(!placed(files.keys(), s!.rules).has('pkg/level/thing_level.asm') && placed(files.keys(), s!.rules).has('pkg/gamemode/thing_gm.asm'), 'a file rule overrides its folder');
  check(JSON.stringify(untaken(files, s!.rules)) === JSON.stringify(['examples/', 'pkg/level/', 'pkg/unpatch.asm', 'pkg/unrelated/', 'readme.txt']), 'untaken parts ' + untaken(files, s!.rules).join(' '));
  check(docFiles(files)[0] === 'readme.txt', 'readme found');
  check(suggestMapping(new Map([['thing.asm', enc.encode('init:\nrtl\n')]])) === null, 'single resource: no suggestion');
  // the rest: each .asm by itself with what it includes (found in the package by name), other files as they are
  files.set('examples/blocks/b.asm', enc.encode('incsrc "settings.asm"\ndb $42\n'));
  files.set('extra/music.txt', enc.encode('#amk 2\n'));
  const parts = extraParts(files, suggestMapping(files)!.rules);
  const b = parts.find((x) => x.path === 'examples/blocks/b.asm');
  check(!!b?.files?.has('settings.asm') && b.files.get('settings.asm') === files.get('pkg/thing_cfg/settings.asm') && !!b.files.has('more/x.asm'), 'extra part with its includes from the package (also nested)');
  check(parts.some((x) => x.path === 'extra/music.txt' && !x.files) && !parts.some((x) => x.path === 'readme.txt' || x.path.startsWith('pkg/library/')), 'other files listed, docs and taken files not');
}

// the editor patch marks the ROM as edited where Lunar Magic keeps its version, but never over Lunar Magic's
{
  const lm = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
  const text = 'Lunar Magic Version 3.31';
  for (let i = 0; i < text.length; i++) lm.w8(0x0ff0a0 + i, text.charCodeAt(i));
  installEditorPatch(lm);
  check(String.fromCharCode(...lm.data.slice(0x7f0a0, 0x7f0a0 + text.length)) === text, "Lunar Magic's version string stays");
}

{
  const files = packageFiles('retry-system_v2.2.0.zip', new Uint8Array(readFileSync('test/fixtures/retry-system_v2.2.0.zip')));
  const s = suggestMapping(files)!;
  const p = placed(files.keys(), s.rules);
  const calls = suggestCalls(files, p, fallback);
  check(s.root === 'src/' && [...s.rules.values()].filter(Boolean).sort().join(' ') === 'gamemode/ library/ retry_config/', 'Retry: suggestion as in its readme');
  check(calls.length === 1 && calls[0].file === 'gamemode/retry_gm.asm' && calls[0].num === ALL, 'Retry: "* retry_gm.asm" from the docs');
  const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
  const proj = emptyProject();
  for (const [from, to] of p) proj.files.set(to, files.get(from)!);
  proj.list.gamemode.set(ALL, [{ file: 'gamemode/retry_gm.asm', bytes: [] }]);
  // an emulator booted before Retry was inserted (like the editor's): its boot snapshot must not be used
  const early = new LevelEmulator(rom); early.boot();
  const r = saveProject(rom, proj);
  // Retry wants a ROM a level editor has marked ($0FF0A0, as Lunar Magic does); the editor patch marks it,
  // without an LM version at $0FF0B4, so Retry takes its vanilla code paths
  check(r.ok, 'Retry assembles on a vanilla ROM ' + r.errors.slice(0, 3).join(' | '));
  check(rom.r8(0x0ff0a0) !== 0xff && rom.r8(0x0ff0b4) < 0x33, 'ROM marked as edited, no LM version');
  if (r.ok) {
    early.syncRom();
    const l = early.load(0x105);
    check(l.ok, 'level loads in an emulator booted before Retry (boot redone) ' + (l.ok ? '' : String((l as { error?: string }).error ?? '')));
  }
  if (r.ok) {
    // falling into a pit: Retry respawns Mario in the level (vanilla: game over with 0 lives)
    const emu = new LevelEmulator(rom); emu.boot();
    emu.load(0x105);
    const t = emu.snes;
    let k = 0; while (t.wram[0x100] !== 0x14 && k++ < 200) t.runFrame();
    for (let i = 0; i < 30; i++) t.runFrame();
    t.wram[0x96] = 0xf0; t.wram[0x97] = 0x01;
    const modes: number[] = [];
    for (let i = 0; i < 400; i++) {
      t.runFrame();
      if (modes[modes.length - 1] !== t.wram[0x100]) modes.push(t.wram[0x100]);
      t.joy1 = i >= 200 && i < 204 ? 0x0080 : 0;
    }
    check(modes.includes(0x0f) && modes[modes.length - 1] === 0x14 && !modes.includes(0x15), `Retry respawns in the level (game modes ${modes.map((m) => m.toString(16)).join(' ')})`);
  }
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
