// The exit graph: where exits lead (old-style: the high bit from the exit's level), which secondary entrances lead
// into a level, which are free, and the names of levels and sub-levels.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { ExitGraph, exitTarget, isBlank } from '../src/core/exitgraph.ts';
import { loadLevel, readSecondaryEntrance, writeSecondaryEntrance } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';

const EDITOR_IMAGE = await editorImage(); // the fixture as the editor opens it

const rom = new Rom(EDITOR_IMAGE.slice());
let bad = 0;
const check = (ok: boolean, what: string) => { if (!ok) { console.log('FAIL', what); bad++; } };

const g = new ExitGraph(rom);
check(g.exits.length > 200, `exits found (${g.exits.length})`);
// level 0BD: secondary exit through entrance 0C0 into 01C (Chocolate Island 5)
check(g.exits.some((e) => e.from === 0xbd && e.secondary && e.entrance === 0xc0 && e.to === 0x1c), '0BD → entrance 0C0 → 01C');
// old-style (no u): the high bit comes from the exit's level
check(exitTarget(rom, 0x105, { dest: 0x05, secondary: false, flags: 0 }).to === 0x105, 'bank 1 exit leads to 1xx');
check(exitTarget(rom, 0x005, { dest: 0x05, secondary: false, flags: 0 }).to === 0x005, 'bank 0 exit leads to 0xx');
check(exitTarget(rom, 0x105, { dest: 0xcb, secondary: true, flags: 2 }).entrance === 0x1cb, 'bank 1 entrance number');
// entrances into Yoshi's Island 1
check(JSON.stringify(g.entrancesOf(0x105)) === JSON.stringify([0x1cb]), `entrances of 105: ${g.entrancesOf(0x105)}`);
check(g.usersOfEntrance(0x1cb).length > 0, 'entrance 1CB is used');
// free entrances: blank, not used
const f1 = g.freeEntrance()!;
check(f1 > 0 && isBlank(rom, f1) && !g.usersOfEntrance(f1).length, `free entrance (${f1})`);
// once set up, it is no longer free and leads into its level
const saved = readSecondaryEntrance(rom, f1);
writeSecondaryEntrance(rom, f1, { ...saved, destLevel: 0x105, screen: 2 });
const g2 = new ExitGraph(rom);
check(g2.freeEntrance() !== f1, 'set-up entrance not free');
check(g2.entrancesOf(0x105).includes(f1), 'set-up entrance listed for 105');
writeSecondaryEntrance(rom, f1, saved);
// the level being edited replaces its ROM exits
const lv = loadLevel(rom, 0x105);
const g3 = new ExitGraph(rom, { number: 0x105, exits: [{ uid: 1, screen: 3, dest: f1, secondary: true, flags: 6 }] });
check(g3.usersOfEntrance(f1).length === 1 && g3.exits.filter((e) => e.from === 0x105).length === 1, 'override exits');
check(lv.exits.length > 0, 'ROM level unchanged');
// names
check(g.label(0x105) === "105 YOSHI'S ISLAND 1", `label 105: ${g.label(0x105)}`);
check(g.parentOf(0x1c3) === 0x118, `parent of 1C3: ${g.parentOf(0x1c3)}`);
check(g.name(0x1c3).includes('118'), `name of sub-level: ${g.name(0x1c3)}`);

console.log(bad ? `${bad} FAILED` : 'testexits OK');
process.exit(bad ? 1 : 0);
