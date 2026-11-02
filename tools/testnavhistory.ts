// Browser history of the editor (ui/navhistory.ts): every place has a URL hash that leads back to it,
// broken hashes lead nowhere, only a change of place (not of what is chosen there) is a new step.
import { toHash, fromHash, stepKey, sameLoc, type NavLoc } from '../src/ui/navhistory.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const places: NavLoc[] = [
  { w: 'level', level: 0x105 },
  { w: 'level', level: 0 },
  { w: 'level', level: 0x1ff },
  { w: 'ow', map: 0 },
  { w: 'ow', map: 6 },
  { w: 'gfx', tab: 'pal' },
  { w: 'gfx', tab: 'pal', pal: 0x21 },
  { w: 'gfx', tab: 'pal', sub: 3, pal: 0x45 },
  { w: 'gfx', tab: 'map16', sub: 0, m16: 0x5f, target: 'ow' },
  { w: 'gfx', tab: 'map16', target: 'fg' },
  { w: 'gfx', tab: 'map16', m16: 0x130, target: 'fg' },
  { w: 'gfx', tab: 'map16', m16: 0x2a, target: 'bg' },
  { w: 'gfx', tab: 'map16', m16: 0x5f, target: 'ow' },
  { w: 'gfx', tab: 'gfx' },
  { w: 'gfx', tab: 'gfx', gfx: 0x14 },
  { w: 'gfx', tab: 'anim' },
  { w: 'gfx', tab: 'anim', anim: { global: true, slot: 3 } },
  { w: 'gfx', tab: 'anim', anim: { global: false, slot: 0x1f } },
  { w: 'game', tab: 'title' },
];
for (const l of places) {
  const back = fromHash(toHash(l));
  check(!!back && sameLoc(back, l), `${toHash(l)} leads back to the place`);
}
check(toHash({ w: 'level', level: 0x105, mode: 'spr', cx: 10, cy: 20 }) === '#level/105', 'mode and scroll position stay out of the hash');
check(fromHash('#gfx/map16/bg/130')?.w === 'gfx', 'hash without leading # works too');

for (const h of ['', '#', '#level', '#level/200', '#level/xyz', '#level/105/1', '#ow/7', '#ow/a', '#gfx', '#gfx/foo',
  '#gfx/pal/100', '#gfx/map16/bg/bg/1', '#gfx/map16/ow/bg/1', '#gfx/anim/x3', '#gfx/anim/g', '#something'])
  check(fromHash(h) === null, `“${h}” leads nowhere`);

const k = (l: NavLoc) => stepKey(l);
check(k({ w: 'gfx', tab: 'map16', m16: 1 }) === k({ w: 'gfx', tab: 'map16', m16: 2, target: 'bg' }), 'other tile in the Map16 tab: no new step');
check(k({ w: 'level', level: 0x105, cx: 1 }) === k({ w: 'level', level: 0x105, mode: 'spr', cx: 50 }), 'scrolling or another mode in the level: no new step');
check(k({ w: 'gfx', tab: 'map16' }) !== k({ w: 'gfx', tab: 'pal' }), 'other graphics tab: new step');
check(k({ w: 'level', level: 0x105 }) !== k({ w: 'level', level: 0x106 }), 'other level: new step');
check(k({ w: 'ow', map: 1 }) !== k({ w: 'ow', map: 2 }), 'other overworld map: new step');
check(k({ w: 'level', level: 0 }) !== k({ w: 'ow', map: 0 }), 'other workspace: new step');

if (bad) { console.log(`${bad} failed`); process.exit(1); }
console.log('all passed');
