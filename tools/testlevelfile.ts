// Level file export/import and screen insert/delete round trips over all vanilla levels.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadLevel, serializeLayer1, serializeLayer2, serializeSprites, isL1Vertical, cloneLevel, insertScreen, deleteScreen, encodeSecondaryHeader, type Level } from '../src/core/level.ts';
import { exportLevelFile, importLevelFile } from '../src/core/levelfile.ts';

const rom = new Rom(new Uint8Array(readFileSync('Super Mario World (U) [!].smc')));
const list = [...Array(0x25).keys(), ...Array.from({ length: 0x3c }, (_, i) => 0x101 + i)];
const dump = (lv: Level) => [serializeLayer1(rom, lv), serializeLayer2(rom, lv) ?? [], serializeSprites(lv.sprites, lv.spriteHeader, isL1Vertical(rom, lv.header.mode)),
  encodeSecondaryHeader(lv.secondary), [lv.layer2Pointer]].map((a) => Array.from(a).join(',')).join('|');
let bad = 0;
for (const n of list) {
  const lv = loadLevel(rom, n);
  const ref = dump(lv);
  const imp = importLevelFile(rom, exportLevelFile(rom, lv), lv).level;
  if (dump(imp) !== ref) { console.log(n.toString(16), 'file round trip differs'); bad++; }
  if (lv.header.screens < 32) {
    for (const s of [0, lv.header.screens >> 1, lv.header.screens - 1]) {
      const c = cloneLevel(lv);
      insertScreen(rom, c, s);
      deleteScreen(rom, c, s);
      // the midway screen is clamped to 4 bits, entrance screens pushed past it may not come back
      if (dump(c) !== ref && lv.secondary.midwayScreen < 15) { console.log(n.toString(16), 'screen insert/delete at', s, 'differs'); bad++; }
    }
  }
}
console.log('levelfile/screens bad', bad);
if (bad) process.exitCode = 1;

// .map16 export reads back the same
{
  const { writeMap16File, parseMap16File } = await import('../src/core/map16file.ts');
  const f = { width: 2, height: 2, tiles: [[1, 2, 3, 4], [5, 6, 7, 8], [0x1234, 0xffff, 0, 9], [10, 11, 12, 13]], acts: [0x25, 0x130, 0x1ff, 0] };
  const g = parseMap16File(writeMap16File(f));
  if (JSON.stringify(g) !== JSON.stringify(f)) { console.log('map16 export roundtrip differs', g); process.exit(1); }
  console.log('map16 export ok');
}
