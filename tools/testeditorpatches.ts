// The editor's own patches installed when a ROM is opened: a clean ROM gets all of them (not SMWM),
// every level loads as before, a second run changes nothing, and a ROM with foreign code at a hook is
// refused and left unchanged.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { installEditorPatches } from '../src/core/editorpatches.ts';
import { editorPatch, customPalettePatch, bgPatch, musicPatch, extGfxPatch } from '../src/core/patches.ts';
import { vramPatchEntry } from '../src/core/vrampatch.ts';
import { exanimEntry, exanimInstalled } from '../src/core/exanim.ts';
import { map16Ext } from '../src/core/map16ext.ts';
import { bgMap16Ext } from '../src/core/bgmap16.ts';
import { structPatch } from '../src/core/structs.ts';
import { messagePatch } from '../src/core/messages.ts';
import { applyPatch } from '../src/core/patchapply.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
const vanilla = new Rom(file.slice());
const rom = new Rom(file.slice());

check(await installEditorPatches(rom), 'clean ROM: patches installed');
check(!!editorPatch(rom), 'SMWE');
check(!!vramPatchEntry(rom), 'SMWV');
check(!!extGfxPatch(rom)?.active, 'SMWG (active)');
check(!!customPalettePatch(rom), 'SMWP');
check(!!bgPatch(rom), 'SMWB');
check(!!musicPatch(rom), 'SMWU');
check(!!map16Ext(rom)?.blocks, 'SMWX with custom blocks');
check(!!bgMap16Ext(rom), 'SMWH');
check(!!structPatch(rom), 'SMWS');
check(exanimInstalled(rom) && exanimEntry(rom)?.kind === 'exanim', 'ExAnimation engine (kind exanim)');
check(!messagePatch(rom), 'no SMWM');

const data = rom.data.slice();
check(!(await installEditorPatches(rom)), 'second run: nothing to do');
check(data.every((b, i) => rom.data[i] === b), 'second run: ROM unchanged');

// every level: same map and colors (VRAM differs: the VRAM patch moves the tilemaps)
const e0 = new LevelEmulator(vanilla); e0.boot();
const e1 = new LevelEmulator(rom); e1.boot();
const levels = [...Array(0x25).keys(), ...Array.from({ length: 0x3b }, (_, i) => 0x101 + i)];
let diff = 0;
for (const n of levels) {
  const a = e0.load(n), b = e1.load(n);
  let d = 0;
  for (let i = 0xc800; i < 0x10000; i++) if (a.wram[i] !== b.wram[i] || a.wram[i + 0x10000] !== b.wram[i + 0x10000]) d++;
  for (let i = 0; i < 0x200; i++) if (a.cgram[i] !== b.cgram[i]) d++;
  if (d || !b.ok) { diff++; console.log('  level', n.toString(16), 'differs in', d, 'bytes', b.error ?? ''); }
}
check(!diff, `levels load as in the clean ROM (${levels.length})`);

// foreign code at an editor hook: refused, ROM unchanged
{
  const taken = new Rom(file.slice());
  const p = applyPatch(taken, { name: 'Foreign', main: 'main.asm', files: new Map([['main.asm', 'lorom\norg $05D8F5\n  JSL $0FFF00\n']]) });
  check(p.ok, 'foreign patch at $05D8F5 applies to a clean ROM');
  const before = taken.data.slice();
  let msg = '';
  try { await installEditorPatches(taken); } catch (e) { msg = (e as Error).message; }
  check(msg.includes('$05D8F5') && msg.includes('Foreign'), 'refused, naming the hook and the patch: ' + msg.replace(/\n/g, ' '));
  check(taken.data.length === before.length && before.every((b, i) => taken.data[i] === b), 'refused ROM unchanged');
}

console.log(bad ? `${bad} failed` : 'all ok');
if (bad) process.exitCode = 1;
