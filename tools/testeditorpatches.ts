// Opening a ROM (editorpatches.ts): a clean ROM gets all of the editor's own patches (not SMWM) and every
// level loads as before; a ROM the editor made opens as it is; any other ROM is refused.
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { prepareRom } from '../src/core/editorpatches.ts';
import { editorPatch, customPalettePatch, bgPatch, musicPatch, extGfxPatch } from '../src/core/patches.ts';
import { vramPatchEntry } from '../src/core/vrampatch.ts';
import { exanimEntry, exanimInstalled } from '../src/core/exanim.ts';
import { map16Ext } from '../src/core/map16ext.ts';
import { bgMap16Ext } from '../src/core/bgmap16.ts';
import { structPatch } from '../src/core/structs.ts';
import { messagePatch } from '../src/core/messages.ts';
import { cleanImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const refused = async (rom: Rom) => { try { await prepareRom(rom); return ''; } catch (e) { return (e as Error).message; } };
const vanilla = new Rom(cleanImage());
const rom = new Rom(cleanImage());

check(await prepareRom(rom), 'clean ROM: patches installed');
check(!!editorPatch(rom), 'SMWE');
check(!!vramPatchEntry(rom), 'SMWV');
check(!!extGfxPatch(rom), 'SMWG');
check(!!customPalettePatch(rom), 'SMWP');
check(!!bgPatch(rom), 'SMWB');
check(!!musicPatch(rom), 'SMWU');
check(!!map16Ext(rom)?.blocks, 'SMWX with custom blocks');
check(!!bgMap16Ext(rom), 'SMWH');
check(!!structPatch(rom), 'SMWS');
check(exanimInstalled(rom) && exanimEntry(rom)?.kind === 'exanim', 'ExAnimation engine (kind exanim)');
check(!messagePatch(rom), 'no SMWM');

// a ROM the editor made: opened as it is (also as exported, with its header)
const data = rom.data.slice();
check(!(await prepareRom(rom)) && data.every((b, i) => rom.data[i] === b), "the editor's own ROM: opened unchanged");
check(!(await refused(Rom.fromFile(rom.output(true)))), "the editor's exported ROM (with header): opened");

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

// anything else is refused: a changed byte in the clean game, an expanded clean ROM
const changed = new Rom(cleanImage());
changed.w8(0x00a1da, 0xea);
check(/Only a clean/.test(await refused(changed)), 'a modified ROM is refused');
const expanded = new Rom(cleanImage());
expanded.expand(0x100000);
check(/Only a clean/.test(await refused(expanded)), 'an expanded (not clean) ROM is refused');

console.log(bad ? `${bad} failed` : 'all ok');
if (bad) process.exitCode = 1;
