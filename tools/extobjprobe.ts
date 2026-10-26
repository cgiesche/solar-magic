// Experiment (issue #117): what a ROM's level load does with each extended object number below $98 (the
// numbers that go through the game's pointer table at $0DA10F, also with Lunar Magic's or ObjecTool's
// dispatcher hook at $0DA106). Level 105 is loaded in the emulator with its own header and a marker object (coins,
// 2x2, at x=2 y=10), then again with extended object N in front of the marker, as 3 to 6 bytes (00 00 N, then
// zeros). "k bytes": with k bytes the map is the marker's alone – the load took k bytes for N and N placed nothing
// (a structure of 4 bytes where the load takes 3 puts the level data out of step: its number is read as the next
// object). "failed": every length failed to load; "other": N placed something or ran code without a handler (an
// empty pointer runs whatever is at $00:0000).
//   node tools/extobjprobe.ts [rom ...]   (default: the clean game and the editor's ROM with structures)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, MAP_BASE, MAP_SIZE } from '../src/core/levelemu.ts';
import { MAP_HI } from '../src/core/ram.ts';
import { L1_PTRS } from '../src/core/level.ts';
import { installStructPatch, EXT_OBJ_TABLE } from '../src/core/structs.ts';
import { cleanImage, editorImage } from './fixture.ts';

const LEVEL = 0x105;
const MARKER = [0x0a, 0x52, 0x11];

function probe(name: string, rom: Rom): void {
  const emu = new LevelEmulator(rom);
  const header = rom.bytes(rom.r24(L1_PTRS + LEVEL * 3), 5);
  const map = (objs: number[]): Uint8Array | null => {
    const r = emu.load(LEVEL, { layer1: Uint8Array.from([...header, ...objs, 0xff]) });
    if (!r.ok) return null;
    const m = new Uint8Array(MAP_SIZE * 2);
    m.set(r.wram.subarray(MAP_BASE, MAP_BASE + MAP_SIZE));
    m.set(r.wram.subarray(MAP_HI + MAP_BASE, MAP_HI + MAP_BASE + MAP_SIZE), MAP_SIZE);
    return m;
  };
  const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.every((v, i) => v === b[i]);
  const a = map(MARKER);
  const kinds = new Map<string, number[]>();
  for (let n = 0; n < 0x98; n++) {
    const maps = [3, 4, 5, 6].map((k) => map([0x00, 0x00, n, ...Array(k - 3).fill(0), ...MARKER]));
    const k = maps.findIndex((m) => same(m, a));
    const kind = k >= 0 ? `${k + 3} bytes` : maps.every((m) => !m) ? 'failed' : 'other';
    kinds.set(kind, [...(kinds.get(kind) ?? []), n]);
  }
  const hx = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');
  console.log(`== ${name}: entry $03 → $${rom.r24(EXT_OBJ_TABLE + 0x03 * 3).toString(16).padStart(6, '0')}`);
  for (const [k, ns] of kinds) console.log(`  ${k.padEnd(15)} ${ns.map(hx).join(' ')}`);
}

const files = process.argv.slice(2);
if (files.length) {
  for (const f of files) {
    try { probe(f.split('/').pop()!, new Rom(new Uint8Array(readFileSync(f)))); } catch (e) { console.log(`== ${f}: ${e}`); }
  }
}
else {
  probe('clean game', new Rom(cleanImage()));
  const ed = new Rom(await editorImage());
  installStructPatch(ed);
  probe('editor ROM with structures', ed);
}
