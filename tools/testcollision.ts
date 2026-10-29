// Collision probe (blockprobe.ts): how Mario collides with vanilla tiles, found by emulation.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { BlockProber, collisionText, switchedText, type CollisionProbe } from '../src/core/blockprobe.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const p = new BlockProber(rom);
const c = (t: number): CollisionProbe => p.probeCollision(t);
const near = (s: [number, number] | null, l: number, r: number) => !!s && Math.abs(s[0] - l) <= 1 && Math.abs(s[1] - r) <= 1;
const desc = (t: number) => `${t.toString(16).toUpperCase()}: ${collisionText(c(t))}`;

check(!c(0x25).top && !c(0x25).bottom && !c(0x25).left && !c(0x25).right, desc(0x25) + ' (air)');
check(c(0x130).top && c(0x130).bottom && c(0x130).left && c(0x130).right && !c(0x130).slope, desc(0x130) + ' (cement block)');
check(c(0x100).top && !c(0x100).bottom && !c(0x100).left && !c(0x100).right, desc(0x100) + ' (ledge)');
check(c(0x12f).hurtsTop && c(0x12f).hurtsSide && !c(0x12f).kills, desc(0x12f) + ' (muncher)');
check(c(0x2).water && !c(0x2).climb, desc(0x2) + ' (water)');
check(c(0x5).kills, desc(0x5) + ' (lava)');
check(c(0x6).climb && !c(0x6).water, desc(0x6) + ' (vine)');
check(near(c(0x1aa).slope, 16, 0), desc(0x1aa) + ' (45° slope up to the right)');
check(near(c(0x1a0).slope, 0, 8) && near(c(0x19b).slope, 8, 0), `${desc(0x1a0)} / ${desc(0x19b)} (gentle slopes)`);
check(near(c(0x173).slope, 12, 8) && near(c(0x18c).slope, 8, 12), `${desc(0x173)} / ${desc(0x18c)} (very gentle slopes)`);

// switch states: only those that change something are kept
const sw = (t: number) => c(t).switched;
check(sw(0x2b).blueP?.collision.top === true && !c(0x2b).top, `2B: ${switchedText(c(0x2b))} (coin: a block under the blue P-switch)`);
check(sw(0x132).blueP?.collision.top === false && c(0x132).top, `132: ${switchedText(c(0x132))} (used block: a coin under the blue P-switch)`);
check(!sw(0x2b).silverP && !sw(0x2b).off, '2B: the silver P-switch and OFF change nothing');
check(sw(0x12f).silverP?.collision.top === false && !sw(0x12f).silverP?.collision.hurtsTop && !sw(0x12f).blueP, `12F: ${switchedText(c(0x12f))} (muncher: a coin under the silver P-switch)`);
check(!Object.keys(sw(0x130)).length && !Object.keys(sw(0x25)).length, '130, 25: no switch changes anything');

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
