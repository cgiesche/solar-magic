// Experiment (issue #110, option A): which extended objects' routines read their table data from bytes the CPU
// also executes as code. Each extended object 10–FF is loaded alone into level 105 (as thumbs.ts does) with the
// load traced (ObjectTrace): its data reads from ROM, and the ROM offsets fetched as instructions – in its own
// load, and over all loads together.
//   node tools/extcodeprobe.ts [rom ...]   (default: the editor's ROM: the clean game with the editor patches)
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator, OV_L1 } from '../src/core/levelemu.ts';
import { loadLevel, encodePrimaryHeader, serializeObjects, newUid } from '../src/core/level.ts';
import { levelBgPointer } from '../src/core/levelheader.ts';
import { pcToSnes } from '../src/core/rom.ts';
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
    const owners: number[] = [-1, -1, -1, -1, -1];
    const body = serializeObjects([{ uid: newUid(), num: 0, ext: n, size: 0, x: 3, y: 12 }], [], false, owners);
    const l1 = new Uint8Array(5 + body.length);
    l1.set(encodePrimaryHeader({ ...level.header, screens: 32, mode: 0 }));
    l1.set(body, 5);
    const byteOwner = new Int32Array(0x10000).fill(-1);
    owners.slice(0, -1).forEach((o, i) => (byteOwner[OV_L1 + i] = o));
    const r = emu.load(level.number, { layer1: l1, layer2Pointer: levelBgPointer(rom, level), sprites: new Uint8Array([0, 0xff]), byteOwner, trace: true });
    if (!r.ok || !r.trace) continue;
    reads.set(n, new Set([...(r.trace.reads.get(0) ?? [])].map((v) => v % 0x800000)));
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
else {

  probe('editor ROM', new Rom(await editorImage()));
}
