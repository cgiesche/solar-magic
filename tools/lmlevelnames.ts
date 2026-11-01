// Lunar Magic's level names in ROMs it saved (docs/research/lunar-magic-level-names.md): where its hooks jump, whether its
// routine is the one the editor writes (core/levelnames.ts), the table's address and RATS block, and every
// translevel's name as the editor reads it. The ROMs are only read here – the editor does not open them (ADR 0004).
// node tools/lmlevelnames.ts <rom.smc> …
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { levelNamePatch, levelName, levelNameTiles, NAME_HOOKS, NAME_LEN, NAME_TRANSLEVELS, NAME_ROUTINE, NAME_ROUTINE_END, NAME_TABLE_OP } from '../src/core/levelnames.ts';
import { editorImage } from './fixture.ts';

const hx = (v: number, d = 6) => v.toString(16).toUpperCase().padStart(d, '0');
const list = (b: ArrayLike<number>) => Array.from(b, (v) => hx(v, 2)).join(' ');
const ours = new Rom(await editorImage());
const routine = (rom: Rom) => { // its table operand aside
  const b = rom.bytes(NAME_ROUTINE, NAME_ROUTINE_END - NAME_ROUTINE), op = NAME_TABLE_OP - NAME_ROUTINE;
  b.fill(0, op, op + 3);
  return b.join();
};
for (const f of process.argv.slice(2)) {
  const raw = new Uint8Array(readFileSync(f)), rom = new Rom(raw.subarray(raw.length % 0x8000));
  console.log(`== ${f}`);
  for (const [a, n] of NAME_HOOKS) console.log(`  hook $${hx(a)}: ${list(rom.bytes(a, n))}`);
  const p = levelNamePatch(rom);
  if (!p) { console.log('  no level names in Lunar Magic\'s layout'); continue; }
  const rats = rom.scanRats().find((r) => r.start + 8 === snesToPc(p.table));
  console.log(`  routine $${hx(NAME_ROUTINE)}: ${routine(rom) === routine(ours) ? 'the editor\'s' : 'differs'}; table $${hx(p.table)}${rats ? `, RATS block of ${hx(rats.size, 4)} bytes` : ', no RATS tag'} (${hx(NAME_TRANSLEVELS, 2)} × ${NAME_LEN})`);
  for (let tl = 0; tl < NAME_TRANSLEVELS; tl++) console.log(`  ${hx(tl, 2)}  ${list(levelNameTiles(rom, tl))}  ${levelName(rom, tl)}`);
}
