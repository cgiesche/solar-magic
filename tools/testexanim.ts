// ExAnimation (Lunar Magic layout, Kobo's engine): installing it leaves vanilla levels as they were;
// a level list animates a VRAM tile from an alternative file, with ON/OFF choosing the second set;
// a color slot changes a palette color; lists read back as written.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadAsar } from '../src/core/asar.ts';
import { installExAnim, writeLevelList, readLevelList, writeAltFile, readAltFile, listBytes, parseList, emptyList, writeGlobalList, readGlobalList, exanimInstalled, type ExList } from '../src/core/exanim.ts';

await loadAsar();
const file = new Uint8Array(readFileSync('test/fixtures/smw.smc'));
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { console.log('FAIL', what); bad++; } };

const vanilla = new Rom(file.slice());
const rom = new Rom(file.slice());
const r = installExAnim(rom);
check(r.ok, 'install ' + r.errors.join(' '));
check(exanimInstalled(rom), 'installed');
const ev = new LevelEmulator(vanilla); ev.boot();
const ep = new LevelEmulator(rom); ep.boot();

// 1. vanilla levels: same tilemaps and graphics after the load and a few frames of animation
for (const n of [0x105, 0x106, 0x101, 0x001, 0x10b]) {
  const a = ev.load(n), b = ep.load(n);
  let d = 0;
  for (let i = 0; i < 0x8000; i++) if (a.vram[i] !== b.vram[i]) d++;
  const fa = ev.animationFrames(8, 8), fb = ep.animationFrames(8, 8);
  for (let k = 0; k < fa.length; k++) for (let i = 0; i < 0x6000; i++) if (fa[k].vram[i] !== fb[k].vram[i]) { d++; break; }
  check(d === 0 && b.ok, `level ${n.toString(16)} unchanged with the engine (${d})`);
}

// 2. a level list: tile $60 (VRAM word $0600) animated from alternative file 0, 2 frames always
const alt = new Uint8Array(0x100);
alt.fill(0x11, 0, 0x20); alt.fill(0x22, 0x20, 0x40); alt.fill(0x33, 0x40, 0x60); alt.fill(0x44, 0x60, 0x80);
writeAltFile(rom, 0, alt);
check(readAltFile(rom, 0)?.length === 0x100, 'alt file reads back');
const list: ExList = emptyList();
list.slots.set(0, { type: 0x01, trigger: 0x00, framesLess1: 1, dest: 0x8000 | 0x0600, frames: [0x00, 0x20] });
// ON/OFF: frames 40 (ON) / 60 (OFF) on tile $61
list.slots.set(1, { type: 0x01, trigger: 0x03, framesLess1: 0, dest: 0x8000 | 0x0610, frames: [0x40, 0x60] });
// color $21 alternating red/blue
list.slots.set(2, { type: 0x14, trigger: 0x00, framesLess1: 1, dest: 0x0021, frames: [0x001f, 0x7c00] });
writeLevelList(rom, 0x105, list);
const back = readLevelList(rom, 0x105);
check(!!back && listBytes(back).join() === listBytes(list).join(), 'level list reads back');
check(parseList(listBytes(list)).length === listBytes(list).length, 'parsed length = bytes');
const tileBytes = (v: Uint8Array, t: number) => v.subarray(t * 32, t * 32 + 32);
const seen60 = new Set<number>(), seen21 = new Set<number>();
ep.load(0x105);
for (const f of ep.animationFrames(16, 4)) {
  seen60.add(tileBytes(f.vram, 0x60)[0]);
  seen21.add(f.cgram[0x42] | (f.cgram[0x43] << 8));
}
check(seen60.has(0x11) && seen60.has(0x22), `tile 60 shows both frames (${[...seen60].map((v) => v.toString(16))})`);
check(seen21.has(0x001f) && seen21.has(0x7c00), `color 21 animates (${[...seen21].map((v) => v.toString(16))})`);
const on = ep.load(0x105, { onOffSwitch: false });
const fOn = ep.animationFrames(4, 8).at(-1)!;
const off = ep.load(0x105, { onOffSwitch: true });
const fOff = ep.animationFrames(4, 8).at(-1)!;
check(on.ok && off.ok && tileBytes(fOn.vram, 0x61)[0] === 0x33 && tileBytes(fOff.vram, 0x61)[0] === 0x44, `ON/OFF picks the frame set (${tileBytes(fOn.vram, 0x61)[0].toString(16)} / ${tileBytes(fOff.vram, 0x61)[0].toString(16)})`);

// 3. another level is unaffected; a global list reaches it
const o = ep.load(0x106), fo = ep.animationFrames(8, 4);
check(o.ok && fo.every((f) => tileBytes(f.vram, 0x60)[0] !== 0x11 && tileBytes(f.vram, 0x60)[0] !== 0x22), 'level 106 has no level animation');
const g = emptyList();
g.slots.set(0, { type: 0x01, trigger: 0x00, framesLess1: 0, dest: 0x8000 | 0x0700, frames: [0x00] });
writeGlobalList(rom, g);
check(readGlobalList(rom)?.slots.get(0)?.dest === (0x8000 | 0x0700), 'global list reads back');
ep.load(0x106);
check(ep.animationFrames(4, 4).some((f) => tileBytes(f.vram, 0x70)[0] === 0x11), 'global list animates level 106');

// 4. removing the level list frees it
writeLevelList(rom, 0x105, null);
check(readLevelList(rom, 0x105) === null, 'level list removed');

console.log(bad ? `${bad} failures` : 'exanim ok');
if (bad) process.exit(1);
