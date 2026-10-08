// Asar patches: WASM Asar assembles, apply/uninstall restores the ROM exactly, conflicts with other
// patches, the editor's own hooks and RATS data are rejected, and levels still load with a patch.
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { applyPatch, uninstallPatch, reapplyPatch, type PatchSource } from '../src/core/patchapply.ts';
import { listPatches } from '../src/core/patchreg.ts';
import { installEditorPatch } from '../src/core/patches.ts';
import { readPackage, detectKind } from '../src/core/patchpkg.ts';
import { installMap16Ext } from '../src/core/map16ext.ts';

await loadAsar();
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const src = (name: string, main: string, extra: Record<string, string> = {}, defines: Record<string, string> = {}): PatchSource =>
  ({ name, main: 'main.asm', files: new Map([['main.asm', main], ...Object.entries(extra)]), defines });

// marker patch: level load (GM $12 palette upload at $00922F) writes !val to $7FB000
const marker = src('Marker', `lorom
incsrc "defs.asm"
org $00922F
  autoclean JSL Code
  NOP #2
freecode
Code:
  STZ $0703 : STZ $0704
  LDA #!val : STA $7FB000
  RTL
Table: skip 3000
`, { 'defs.asm': '!val ?= $5A\n' });

// 1. apply + levels load + marker set
const rom = new Rom(file.slice());
const orig = rom.data.slice();
const r1 = applyPatch(rom, marker);
check(r1.ok && listPatches(rom).length === 1, `apply marker patch ${r1.errors.join(' ')}`);
check(r1.entry!.segs.length === 1 && r1.entry!.segs[0][0] === snesToPc(0x00922f) && r1.entry!.segs[0][1] === 6, 'only the hijack is a segment ' + JSON.stringify(r1.entry!.segs));
const emu = new LevelEmulator(rom); emu.boot();
const levels = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)];
let loadBad = 0;
for (const n of levels) { const l = emu.load(n); if (!l.ok || l.wram[0x1b000] !== 0x5a) loadBad++; }
check(loadBad === 0, `all ${levels.length} levels load with the patch and run its code (${loadBad} bad)`);

// 2. reapply with another define, then uninstall → byte-identical to vanilla (expanded area zero)
const r2 = reapplyPatch(rom, r1.entry!.id, { ...marker, defines: { val: '$33' } });
check(r2.ok && listPatches(rom).length === 1 && rom.scanRats().length === 3, `reapply with define (${rom.scanRats().length} RATS blocks: code, backup, registry)`);
emu.syncRom();
check(emu.load(0x105).wram[0x1b000] === 0x33, 'define reaches the code');
check(uninstallPatch(rom, r2.entry!.id).length === 0, 'uninstall without warnings');
let diff = 0;
for (let i = 0; i < rom.data.length; i++) if (rom.data[i] !== (i < orig.length ? orig[i] : 0) && i !== 0x7fd7) diff++;
check(diff === 0 && listPatches(rom).length === 0 && rom.scanRats().length === 0, `uninstall restores the ROM (${diff} bytes differ)`);

// 3. conflicts
{
  const rom = new Rom(file.slice());
  const a = applyPatch(rom, marker);
  const snap = rom.data.slice();
  const b = applyPatch(rom, src('Overlap', 'lorom\norg $009232\ndb $EA\n'));
  check(!b.ok && b.errors[0].includes('Marker') && rom.data.every((v, i) => v === snap[i]), 'overlapping hijack rejected: ' + b.errors[0]);
  const ownAt = a.entry!.own[0] + 8;
  const c = applyPatch(rom, src('IntoCode', `lorom\norg $${(((ownAt >> 15) << 16) | 0x8000 | (ownAt & 0x7fff)).toString(16)}\ndb $EA\n`));
  check(!c.ok && c.errors[0].includes('Marker'), 'write into another patch\'s free space rejected: ' + c.errors[0]);
  installEditorPatch(rom);
  const d = applyPatch(rom, src('HitsSMWE', 'lorom\norg $05D8F5\ndb $EA\n'));
  check(!d.ok && d.errors[0].includes('SMWE'), 'hook of installed built-in rejected: ' + d.errors[0]);
  const e = applyPatch(rom, src('HitsSMWX', 'lorom\norg $00F545\nJML $00F545\n'));
  check(e.ok && e.warnings.some((w) => w.includes('SMWX')), 'hook of a built-in not yet installed only warns');
  let msg = '';
  try { installMap16Ext(rom, [0, 0, 0, 0]); } catch (err) { msg = (err as Error).message; }
  check(msg.includes('HitsSMWX'), 'built-in names the patch that took its hook: ' + msg);
  const f = applyPatch(rom, src('Broken', 'lorom\nLDA #$1234,q\n'));
  check(!f.ok && f.errors[0].includes('main.asm:2'), 'Asar errors are reported: ' + f.errors[0]);
}

// 3b. smwe.asm describes the ROM's editor patches
{
  const rom = new Rom(file.slice());
  const e = installEditorPatch(rom);
  const r = applyPatch(rom, src('UsesSmwe', 'lorom\nincsrc "smwe.asm"\n%smwe_require(PATCH)\nprint hex(!SMWE_SPRITE_BANKS)\nprint dec(!SMWE_MAP16X)\n'));
  check(r.ok && r.prints[0] === e.sprBank.toString(16).toUpperCase().padStart(6, '0') && r.prints[1] === '0', 'smwe.asm has the editor tables ' + r.prints.join(' ') + r.errors.join(' '));
  const f = applyPatch(rom, src('NeedsX', 'lorom\nincsrc "smwe.asm"\n%smwe_require(MAP16X)\n'));
  check(!f.ok && f.errors[0].includes('MAP16X'), '%smwe_require fails for missing features');
}

// 4. untagged patch data in expanded space is never taken as free space
{
  const rom = new Rom(file.slice());
  rom.expand(0x100000);
  const r = applyPatch(rom, src('Untagged', 'lorom\norg $108000\ndb 1,2,3,4,5,6,7,8\n'));
  const a = rom.allocWrite(new Uint8Array(16).fill(0x77));
  check(r.ok && snesToPc(a) - 8 >= 0x80000 + 16 && rom.data[0x80000] === 1, `allocWrite skips untagged data (at $${a.toString(16)})`);
}

// 5. what a download is: patch, UberASM resource, GPS block, PIXI sprite
{
  const kind = (name: string, text: string) => detectKind(readPackage(name, new TextEncoder().encode(text)));
  check(kind('p.asm', 'lorom\norg $00A1DA\nJSL Code\nfreecode\nCode:\nRTL\n').kind === 'patch', 'detect: patch');
  check(kind('u.asm', '; resource\n!x = 1\nmain:\n  LDA $71\n  RTL\n').kind === 'uberasm', 'detect: UberASM resource');
  const b = kind('b.asm', '; Act like 130\nprint "a block"\ndb $42\nJMP A : JMP A\nA: RTL\n');
  check(b.kind === 'block' && b.acts === 0x130, 'detect: GPS block with acts like from its description');
  check(kind('s.asm', 'print "INIT ",pc\nRTL\nprint "MAIN ",pc\nRTL\n').kind === 'pixi', 'detect: PIXI sprite');
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
