// The brush convention's geometry (ADR 0011, ui/brushsurface.ts): a pick's rectangle from its corners in any order,
// a stroke's stamps on the brush's grid from its first cell (as the level and the overworld editors stamp).
// node tools/testbrushsurface.ts
import { pickRect, brushGridCell } from '../src/ui/brushsurface.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

check(same(pickRect(3, 4, 3, 4), { x: 3, y: 4, w: 1, h: 1 }), 'a click picks its cell');
check(same(pickRect(5, 2, 1, 6), { x: 1, y: 2, w: 5, h: 5 }) && same(pickRect(1, 6, 5, 2), pickRect(5, 2, 1, 6)), 'a drag picks the rectangle between its corners, either way');

// a 4x2 brush begun at (10, 5)
const at = (x: number, y: number) => brushGridCell(10, 5, 4, 2, x, y);
check(same(at(10, 5), { x: 10, y: 5 }) && same(at(13, 6), { x: 10, y: 5 }), 'within the brush: the first stamp');
check(same(at(14, 5), { x: 14, y: 5 }) && same(at(17, 6), { x: 14, y: 5 }) && same(at(18, 7), { x: 18, y: 7 }), 'right and down: steps of 4 and 2');
check(same(at(9, 4), { x: 6, y: 3 }) && same(at(6, 3), { x: 6, y: 3 }) && same(at(5, 2), { x: 2, y: 1 }), 'left and up: on the same grid');
check(same(brushGridCell(3, 3, 1, 1, 7, 9), { x: 7, y: 9 }), 'a 1x1 brush: every cell');

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
