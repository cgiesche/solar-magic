// Sprite memory check (src/core/spritemem.ts): $E0 (three platforms on chains) in level 00C with
// its sprite memory 00 loses tiles, a suggested value shows all of them; levels keep their
// own value free of conflicts (no false alarms). Usage: node tools/testspritemem.ts [levels,hex]
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, newUid } from '../src/core/level.ts';
import { checkSpriteMemory, spriteWindows, suggestSpriteMemory, usedSpriteMemory } from '../src/core/spritemem.ts';
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

const rom = new Rom(EDITOR_IMAGE.slice());
const emu = new LevelEmulator(rom);
emu.boot();
const bgOf = (p: number) => (p >> 16 === 0xff ? p : 0xffd900);
let bad = 0;
const fail = (msg: string) => { bad++; console.log('FAIL', msg); };
const candidates = usedSpriteMemory(rom);
console.log('used sprite memory', candidates.map((m) => m.toString(16)).join(' '));

// $E0 in level 00C
{
  const lv = loadLevel(rom, 0xc);
  const ctx = { emu, level: 0xc, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const wins = [[{ uid: newUid(), num: 0xe0, x: 8, y: 0x14, extra: 0 }]];
  const m = lv.spriteHeader & 0x3f;
  const base = checkSpriteMemory(ctx, m, wins);
  if (!base.conflicts.size) fail(`00C: $E0 with ${m.toString(16)} shows no conflict`);
  const s = suggestSpriteMemory(ctx, m, candidates, wins, base);
  if (s === null) fail('00C: no suggestion');
  else {
    const c = checkSpriteMemory(ctx, s, wins);
    if (c.conflicts.size || c.live[0] < base.live[0]) fail(`00C: suggestion ${s.toString(16)} does not help`);
    console.log(`00C $E0: ${m.toString(16)} → ${s.toString(16)}`);
  }
}

// levels with their own sprite memory
const list = process.argv[2] ? process.argv[2].split(',').map((x) => parseInt(x, 16)) : [0x5, 0x23, 0x135, 0x105, 0x106, 0x1, 0x2, 0x101, 0x103, 0x10b];
for (const n of list) {
  const lv = loadLevel(rom, n);
  const ctx = { emu, level: n, header: lv.header, bgPointer: bgOf(lv.layer2Pointer) };
  const t0 = Date.now();
  const wins = spriteWindows(lv.sprites);
  const c = checkSpriteMemory(ctx, lv.spriteHeader & 0x3f, wins);
  const names = [...c.conflicts].map((u) => { const s = lv.sprites.find((q) => q.uid === u)!; return `${s.num.toString(16)}@${s.x},${s.y}`; });
  console.log(`${n.toString(16).padStart(3, '0')} mem=${(lv.spriteHeader & 0x3f).toString(16)} sprites=${lv.sprites.length} windows=${wins.length} ${Date.now() - t0}ms conflicts=${names.join(' ') || '-'}`);
  if (c.conflicts.size) fail(`${n.toString(16)}: conflicts with its own sprite memory`);
}
console.log('bad', bad);
if (bad) process.exitCode = 1;
