// Experiment (issue #110, option A): which extended objects' routines read their table data from bytes the CPU
// also executes as code. Each extended object 10–FF is loaded alone into level 105 (as thumbs.ts does) with the
// load traced (ObjectTrace): its data reads from ROM, and the ROM offsets fetched as instructions – in its own
// load, and over all loads together.
//   node tools/extcodeprobe.ts [rom ...]   (default: the editor's ROM: the clean game with the editor patches)
import { readFileSync } from 'node:fs';
import { Rom, pcToSnes } from '../src/core/rom.ts';
import { LevelEmulator, readOffset } from '../src/core/levelemu.ts';
import { loadLevel, newUid } from '../src/core/level.ts';
import { effectLoad } from '../src/core/objeffects.ts';
import { editorImage } from './fixture.ts';

const hx = (v: number, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');
const runs = (ns: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(i === j ? hx(ns[i]) : `${hx(ns[i])}–${hx(ns[j])}`);
    i = j;
  }
  return out.join(' ') || '–';
};

function probe(name: string, rom: Rom): void {
  const emu = new LevelEmulator(rom);
  const level = loadLevel(rom, 0x105);
  const reads = new Map<number, Set<number>>(), own = new Map<number, Set<number>>();
  const all = new Set<number>();
  for (let n = 0x10; n < 0x100; n++) {
    const r = effectLoad(emu, level, [{ uid: newUid(), num: 0, ext: n, size: 0, x: 0, y: 0 }], true, true);
    if (!r.ok || !r.trace) continue;
    reads.set(n, new Set([...(r.trace.reads.get(0) ?? [])].map(readOffset)));
    own.set(n, r.trace.code);
    for (const c of r.trace.code) all.add(c);
  }
  const inOwn: number[] = [], inAll: number[] = [];
  for (const [n, rs] of reads) {
    if ([...rs].some((o) => own.get(n)!.has(o))) inOwn.push(n);
    if ([...rs].some((o) => all.has(o))) inAll.push(n);
  }
  console.log(`== ${name}`);
  console.log(`  read data from code of their own load: ${runs(inOwn)}`);
  console.log(`  read data from code of any load:       ${runs(inAll)}`);
  for (const n of [0x47, 0x48, 0x98, 0xc2, 0xd7, 0xff]) {
    const rs = [...(reads.get(n) ?? [])].sort((a, b) => a - b);
    console.log(`  ${hx(n)} reads ${rs.map((o) => `$${hx(pcToSnes(o), 6)}${all.has(o) ? '(code)' : ''}`).join(' ')}`);
  }
}

const files = process.argv.slice(2);
if (files.length) for (const f of files) probe(f.split('/').pop()!, new Rom(new Uint8Array(readFileSync(f))));
else probe('editor ROM', new Rom(await editorImage()));
