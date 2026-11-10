// The game's hardcoded overworld paths learned by emulation (owhardpaths.ts): in the clean game the walks its tables
// ($049078 ff., read here as the oracle) describe; none with Lunar Magic's "Allow hardcoded default layer 1 paths" off;
// with Kevin's "Custom Overworld Hardcoded Paths" (test/fixtures/more_hardcoded_paths.zip) its tables' – the game's 5
// paths with its default tables, a path added to them learned as well – and none with Lunar Magic's switch off then
// too (the option's note says so). docs/research/smw-hardcoded-overworld-paths.md
import { Rom, snesToPc } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { l1Index, l1XY, readTranslevels, translevelToLevel, DIR_NAMES } from '../src/core/overworld.ts';
import { layer1AtEveryProgress } from '../src/core/owcellhistory.ts';
import { neighbor } from '../src/core/owreach.ts';
import { owOptionValue, setOwOption, owOption, hardPathsHooked } from '../src/core/owoptions.ts';
import type { HardWalk } from '../src/core/owhardpaths.ts';
import { editorImage, pathKinds, hardWalks, applyHardPathsPatch } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const at = (i: number) => (i < 0 ? 'nowhere' : `${i >> 10 ? 'submaps' : 'main'} ${hx(l1XY(i).x)},${hx(l1XY(i).y)}`);
const text = (w: HardWalk) => `${at(w.from)} ${DIR_NAMES[w.dir]}: ${w.path.map(at).join(' ')} → ${at(w.to)}`;
const same = (a: HardWalk[], b: HardWalk[]) => {
  const key = (w: HardWalk) => `${w.from}:${w.dir}:${w.path.join()}:${w.to}:${w.arrive}`;
  return a.map(key).sort().join('|') === b.map(key).sort().join('|');
};

await loadAsar();
const image = await editorImage(), fresh = () => new Rom(image.slice());
const kinds = pathKinds(fresh());

// The oracle: the walks the game's own tables describe ($049078 levels, $0490CA directions, $049086 tiles, $04910E
// start offsets, $049082/$049084 the pipe's Y/X), the steps followed from each tile of the entry's translevel (or
// the main map's tile at the position) – the game's code as SMWDisX has it, for the clean game only
function tableWalks(rom: Rom): HardWalk[] {
  const r8 = (a: number) => rom.data[snesToPc(a)], tls = readTranslevels(rom), out: HardWalk[] = [];
  for (let x = 0; x < 10; x++) {
    const from = r8(0x049078 + x), a = r8(0x04910e + x), b = x < 9 ? r8(0x04910e + x + 1) : 0x44;
    const dirs = Array.from({ length: b - a }, (_, k) => r8(0x0490ca + a + k) >> 1);
    const starts = from === 0xff ? [l1Index(0, rom.r16(0x049084) >> 4, rom.r16(0x049082) >> 4)] : [...tls.keys()].filter((i) => tls[i] === from);
    for (const s of starts) {
      const cells: number[] = [];
      let cur = s;
      for (const d of dirs) { cur = neighbor(cur, d); cells.push(cur); }
      out.push({ from: s, dir: dirs[0], path: cells.slice(0, -1), to: cells.at(-1)!, arrive: dirs.at(-1)! });
    }
  }
  return out;
}

// ---- the clean game: its tables' walks ----
const vanilla = hardWalks(fresh(), kinds), table = tableWalks(fresh());
check(vanilla.length === 10 && same(vanilla, table), `the clean game: the ${vanilla.length} walks of its tables (${table.length})`);
const dp1 = vanilla.find((w) => translevelToLevel(readTranslevels(fresh())[w.from]) === 0x15);
check(!!dp1 && dp1.dir === 2 && dp1.path.length === 5 && translevelToLevel(readTranslevels(fresh())[dp1.to]) === 0x09, `015 → 009: ${dp1 && text(dp1)}`);

// ---- Lunar Magic's switch off: none ----
{
  const rom = fresh();
  setOwOption(rom, 'hardcodedPaths', false);
  const got = hardWalks(rom, kinds);
  check(got.length === 0 && owOption('hardcodedPaths').note?.(rom) === null, `"Allow hardcoded default layer 1 paths" off: ${got.length} walks, no note`);
}

// ---- Kevin's patch ----
// the ROM with the patch applied, its tables file changed by `edit`
const patched = (edit?: (s: string) => string): Rom => applyHardPathsPatch(fresh(), edit);
{
  const rom = patched(), got = hardWalks(rom, kinds);
  check(hardPathsHooked(rom) && !hardPathsHooked(fresh()) && owOptionValue(rom, 'hardcodedPaths') === true, 'the patch hooks the lookup ($049312), Lunar Magic\'s switch reads on');
  // (its walks follow the path tiles' shapes, not the game's directions: compared by where they lead and what they cross)
  const ends = (ws: HardWalk[]) => ws.map((w) => `${w.from}:${w.dir}:${[...w.path].sort().join()}:${w.to}`).sort().join('|');
  check(got.length === 10 && ends(got) === ends(vanilla), `with its default tables: the game's 5 paths both ways (${got.length} walks${got.length === 10 ? '' : `: ${got.map(text).join('; ')}`})`);
  setOwOption(rom, 'hardcodedPaths', false);
  const note = owOption('hardcodedPaths').note?.(rom) ?? '';
  check(hardWalks(rom, kinds).length === 0 && note.includes('Kevin'), `Lunar Magic's switch off: the patch's paths off too, said by the note ("${note}")`);
}
{
  // a path of its own added: from a level tile of the main map with nothing on its left for 3 tiles, two path tiles 04
  // left to a level tile 66 (one way: the second level FE is no translevel)
  const tls = readTranslevels(fresh()), l1 = layer1AtEveryProgress(fresh()).at(-1)!;
  const free = (i: number) => i >= 0 && kinds[l1[i]] === 'none';
  const from = [...tls.keys()].find((i) => i < 0x400 && tls[i] && kinds[l1[i]] === 'level' && !vanilla.some((w) => w.from === i)
    && free(neighbor(i, 2)) && free(neighbor(neighbor(i, 2), 2)) && free(neighbor(neighbor(neighbor(i, 2), 2), 2)))!;
  const rom = patched((s) => s.replace(/\r\n/g, '\n').replace(/^levels:\n((?:.*\n)*?)\.05:/m, (m) => `${m}    db $${hx(tls[from])},$FE`)
    .replace(/^directions:\n((?:.*\n)*?)\.05:/m, (m) => `${m}    db !Left,!Left`)
    .replace(/^\.05_1:\n\.05_2:/m, '.05_1:  db $04,$04,$66\n.05_2:  db $04')
    .replace(/^(animation:\n(?:.*\n)*?)\.05_1:\n\.05_2:/m, '$1.05_1:  db $00,$00,$00\n.05_2:  db $00'));
  const got = hardWalks(rom, kinds), mine = got.find((w) => w.from === from);
  const n1 = neighbor(from, 2), n2 = neighbor(n1, 2), n3 = neighbor(n2, 2);
  check(got.length === 11 && !!mine && mine.dir === 2 && mine.path.join() === [n1, n2].join() && mine.to === n3,
    `a path added to its tables (level ${hx(translevelToLevel(tls[from]), 3)} left): learned too (${mine ? text(mine) : 'none'}; ${got.length} walks)`);
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('hardcoded paths ok');
