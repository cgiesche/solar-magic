// Lunar Magic's level names in ROMs it saved (docs/research/lunar-magic-level-names.md): where its hooks jump, whether its
// routine is the one the editor writes (core/levelnames.ts), the table's address and RATS block, and every
// translevel's name as the editor reads it. The ROMs are only read here – the editor does not open them (ADR 0004).
// node tools/lmlevelnames.ts <rom.smc> …
import { readFileSync } from 'node:fs';
import { Rom, snesToPc } from '../src/core/rom.ts';
import { levelNamePatch, levelName, levelNameTiles, NAME_HOOKS, NAME_LEN, NAME_TRANSLEVELS } from '../src/core/levelnames.ts';
import { editorImage } from './fixture.ts';

const hx = (v: number, d = 6) => v.toString(16).toUpperCase().padStart(d, '0');
const bytes = (rom: Rom, a: number, n: number) => [...rom.bytes(a, n)].map((b) => hx(b, 2)).join(' ');
const ours = new Rom(await editorImage());
const routine = (rom: Rom) => { const b = rom.bytes(0x03bb20, 0x52); b.fill(0, 0x37, 0x3a); return b.join(); }; // its table operand aside
for (const f of process.argv.slice(2)) {
  const raw = new Uint8Array(readFileSync(f)), rom = new Rom(raw.subarray(raw.length % 0x8000));
  console.log(`== ${f}`);
  for (const [a, n] of NAME_HOOKS) console.log(`  hook $${hx(a)}: ${bytes(rom, a, n)}`);
  const p = levelNamePatch(rom);
  if (!p) { console.log('  no level names in Lunar Magic\'s layout'); continue; }
  const rats = rom.scanRats().find((r) => r.start + 8 === snesToPc(p.table));
  console.log(`  routine $03BB20: ${routine(rom) === routine(ours) ? 'the editor\'s' : 'differs'}; table $${hx(p.table)}${rats ? `, RATS block of ${hx(rats.size, 4)} bytes` : ', no RATS tag'} (${hx(NAME_TRANSLEVELS, 2)} × ${NAME_LEN})`);
  for (let tl = 0; tl < NAME_TRANSLEVELS; tl++) console.log(`  ${hx(tl, 2)}  ${bytes({ bytes: () => Uint8Array.from(levelNameTiles(rom, tl)) } as unknown as Rom, 0, NAME_LEN)}  ${levelName(rom, tl)}`);
}
