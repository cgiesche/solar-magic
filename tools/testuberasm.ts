// UberASM: list.txt round trip, generated patch assembles, level/global code runs in the emulator
// only where assigned, extra bytes/libraries/shared routines work, uninstall restores the ROM.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch, uninstallPatch } from '../src/core/patchapply.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { parseList, writeList, buildUberPatch } from '../src/core/uberasm.ts';
import { projectFromZip, saveProject, loadProject, uberEntry } from '../src/core/uberproject.ts';
import { zipSync } from 'fflate';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();

const listTxt = `; test
verbose: on
level:
105 marker.asm, bytes.asm : 5A
106 bytes.asm : @16
overworld:
gamemode:
14 gm.asm
global: other/global_code.asm
macrolib: other/macro_library.asm
freeram: $7FAC80
`;
const files = new Map<string, Uint8Array>(Object.entries({
  'list.txt': listTxt,
  'level/marker.asm': 'load:\n  LDA #$11 : STA $7FB001\n  RTL\ninit:\n  JSL util_Set\n  %UberRoutine(Mark)\n  RTL\nmain:\n  LDA $7FB008 : INC : STA $7FB008\n  RTL\n',
  'level/bytes.asm': ';>bytes 1\nload:\n  LDA ($00) : STA $7FB003\n  PHB : PLA : STA $7FB006\n  RTL\n',
  'gamemode/gm.asm': 'main:\n  LDA $7FB004 : INC : STA $7FB004\n  RTL\n',
  'library/util.asm': 'Set:\n  LDA #!MarkValue : STA $7FB002\n  RTL\n',
  'routines/Mark.asm': 'LDA #$77 : STA $7FB007\nRTL\n',
  'other/global_code.asm': 'init:\n  LDA #$99 : STA $7FB005\n  RTS\n',
  'other/macro_library.asm': '!MarkValue = $22\n',
}).map(([k, v]) => [k, enc.encode(v)]));

// list.txt parse / write round trip
const list = parseList(listTxt);
check(list.level.get(0x105)?.length === 2 && list.level.get(0x106)?.[0].bytes[0] === 16 && list.gamemode.get(0x14)?.[0].file === 'gamemode/gm.asm', 'list.txt parsed');
const again = parseList(writeList(list));
check(JSON.stringify([...again.level]) === JSON.stringify([...list.level]) && again.global === list.global && again.freeram === list.freeram, 'writeList round trip');

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
installEditorPatch(rom);
const before = rom.data.slice();
const b = buildUberPatch(files, list);
check(b.resources === 3 && b.warnings.length === 0, `build: ${b.resources} resources ${b.warnings.join(' ')}`);
const r = applyPatch(rom, b.source);
check(r.ok, 'UberASM patch assembles ' + r.errors.slice(0, 3).join(' | '));
if (!r.ok) console.log((b.source.files.get('__uber_main.asm') as string).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));

if (r.ok) {
  const emu = new LevelEmulator(rom); emu.boot();
  const w = (l: { wram: Uint8Array }, a: number) => l.wram[a - 0x7e0000];
  const l5 = emu.load(0x105), l6 = emu.load(0x106), l7 = emu.load(0x107);
  check(l5.ok && w(l5, 0x7fb001) === 0x11 && w(l6, 0x7fb001) === 0 && w(l7, 0x7fb001) === 0, 'level load code runs only in its level');
  check(w(l5, 0x7fb003) === 0x5a && w(l6, 0x7fb003) === 16 && w(l7, 0x7fb003) === 0, `extra bytes per level (${w(l5, 0x7fb003)}, ${w(l6, 0x7fb003)})`);
  check(w(l5, 0x7fb006) >= 0x90, `DBR = resource bank ($${w(l5, 0x7fb006).toString(16)})`);
  check(w(l5, 0x7fb005) === 0x99, 'global init ran at power-on');
  console.log(`     level init: library $${w(l5, 0x7fb002).toString(16)}, routine $${w(l5, 0x7fb007).toString(16)}, gamemode 14 frames ${w(l5, 0x7fb004)}`);
  // a few frames of gameplay run the game mode $14 main code
  const s = emu.snes;
  emu.load(0x105);
  let g = 0; while (s.wram[0x100] !== 0x14 && g++ < 100) s.runFrame();
  const f0 = w(s, 0x7fb004);
  for (let i = 0; i < 30; i++) s.runFrame();
  check(w(s, 0x7fb004) - f0 >= 25, `game mode $14 main runs every frame (+${w(s, 0x7fb004) - f0} in 30 frames)`);
  check(w(s, 0x7fb008) >= 25, `level main runs (${w(s, 0x7fb008)} frames)`);
  // gameplay is the same as without UberASM: run right for 120 frames
  const run = (e: LevelEmulator, n: number) => {
    e.load(n);
    const t = e.snes;
    let k = 0; while (t.wram[0x100] !== 0x14 && k++ < 100) t.runFrame();
    t.joy1 = 0x0100;
    for (let i = 0; i < 120; i++) t.runFrame();
    t.joy1 = 0;
    return t.wram[0x94] | (t.wram[0x95] << 8);
  };
  const plain = new LevelEmulator(new Rom(before.slice())); plain.boot();
  const same = [0x105, 0x106, 0x107, 0x001].every((n) => run(emu, n) === run(plain, n));
  check(same, 'Mario moves the same with and without UberASM');
  let loadBad = 0;
  for (const n of [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)]) if (!emu.load(n).ok) loadBad++;
  check(loadBad === 0, `all levels load with UberASM (${loadBad} bad)`);
  const e = listPatches(rom)[0];
  check(e.kind === 'uberasm' && !!e.srcId && !!rom.getBlob(e.srcId) && !e.src, 'registered as UberASM with sources in the editor data (not in the ROM)');
  uninstallPatch(rom, e.id);
  let diff = 0;
  for (let i = 0; i < rom.data.length; i++) if (rom.data[i] !== (i < before.length ? before[i] : 0) && i !== 0x7fd7) diff++;
  check(diff === 0, `uninstall restores the ROM (${diff} bytes differ)`);
  check(rom.extra.size === 0, 'sources dropped with the patch');
}

// project round trip: UberASM Tool folder as zip → ROM → back
{
  const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const zip = zipSync({ ...Object.fromEntries([...files].map(([k, v]) => ['MyHack/' + k, v])), 'MyHack/UberASMTool.exe': new Uint8Array(4), 'MyHack/asm/base/main.asm': enc.encode('junk') });
  const p = projectFromZip(zip);
  check(p.files.has('level/marker.asm') && !p.files.has('UberASMTool.exe') && !p.files.has('asm/base/main.asm'), 'import drops the tool\'s own files');
  const r = saveProject(rom, p);
  const back = loadProject(rom);
  check(r.ok && !!back && back.list.level.get(0x105)?.length === 2 && back.files.size === p.files.size, 'project saved to and loaded from the ROM ' + r.errors.join(' '));
  back!.list.level.delete(0x106);
  check(saveProject(rom, back!).ok && loadProject(rom)!.list.level.size === 1, 'changed assignments reapplied');
  const empty = { files: new Map(), list: parseList('') };
  check(saveProject(rom, empty).ok && !uberEntry(rom), 'empty project removes UberASM');
}

// library with namespaces of its own and files outside library/ (as Retry System has): like UberASM
// Tool, each library is assembled on its own and exports its labels as <file>_<label>; include paths
// with "//" and several ".." in a row resolve like on a real file system
{
  const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
  const lib = new Map<string, Uint8Array>(Object.entries({
    'library/big.asm': 'namespace ram\nincsrc "../big_config//ram.asm"\nnamespace off\nnamespace shared\nincsrc "../big_config/code/x/shared.asm"\nnamespace off\n',
    'big_config/ram.asm': 'value: db $5C\n',
    'big_config/code/x/shared.asm': 'get:\n  LDA.l ram_value\n  STA $7FB00A\n  RTL\nlate:\n  JSL shared_get\n  RTL\ngfx:\n  incbin "../../gfx/a.bin":0..2\n',
    'big_config/gfx/a.bin': new Uint8Array([1, 2, 3, 4]),
    'level/use.asm': 'init:\n  JSL big_shared_late\n  RTL\n',
  }).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v]));
  const p = { files: lib, list: parseList('level:\n105 use.asm\n') };
  const r = saveProject(rom, p);
  check(r.ok, 'library with own namespaces and ../.. includes assembles ' + r.errors.slice(0, 3).join(' | '));
  if (r.ok) {
    const emu = new LevelEmulator(rom); emu.boot();
    const l = emu.load(0x105);
    check(l.wram[0x7fb00a - 0x7e0000] === 0x5c, 'library labels reach the level code');
  }
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
