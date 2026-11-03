// The brush convention's geometry (ADR 0011, ui/brushsurface.ts): a pick's rectangle from its corners in any order,
// a stroke's stamps on the brush's grid from its first cell; the buttons that paint; a drag (BrushDrag) picking,
// painting on the grid, ending, cancelled by Esc, and the frame it shows.
// node tools/testbrushsurface.ts
import { pickRect, brushGridCell, paintButton, BrushDrag } from '../src/ui/brushsurface.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check(same(pickRect(3, 4, 3, 4), { x: 3, y: 4, w: 1, h: 1 }), 'a click picks its cell');
check(same(pickRect(5, 2, 1, 6), { x: 1, y: 2, w: 5, h: 5 }) && same(pickRect(1, 6, 5, 2), pickRect(5, 2, 1, 6)), 'a drag picks the rectangle between its corners, either way');

// a 4x2 brush begun at (10, 5)
const at = (x: number, y: number) => brushGridCell(10, 5, 4, 2, x, y);
check(same(at(10, 5), { x: 10, y: 5 }) && same(at(13, 6), { x: 10, y: 5 }), 'within the brush: the first stamp');
check(same(at(14, 5), { x: 14, y: 5 }) && same(at(17, 6), { x: 14, y: 5 }) && same(at(18, 7), { x: 18, y: 7 }), 'right and down: steps of 4 and 2');
check(same(at(9, 4), { x: 6, y: 3 }) && same(at(6, 3), { x: 6, y: 3 }) && same(at(5, 2), { x: 2, y: 1 }), 'left and up: on the same grid');
check(same(brushGridCell(3, 3, 1, 1, 7, 9), { x: 7, y: 9 }), 'a 1x1 brush: every cell');

// the buttons: right, or Shift+left (not with Ctrl) paint; left picks
const btn = (button: number, shiftKey = false, ctrlKey = false) => paintButton({ button, shiftKey, ctrlKey });
check(btn(2) && btn(0, true) && !btn(0) && !btn(0, true, true) && !btn(1), 'right and Shift+click paint; left, Shift+Ctrl+left and the middle button don\'t');

// a drag with a 2x2 brush: what it asks of its editor
{
  const log: string[] = [];
  const d = new BrushDrag({
    brush: () => ({ w: 2, h: 2 }),
    stamp: (x, y) => { log.push(`stamp ${x},${y}`); return true; },
    end: () => log.push('end'), cancel: () => log.push('cancel'), pick: (r) => log.push(`pick ${r.x},${r.y} ${r.w}x${r.h}`),
  });
  d.startPick({ x: 4, y: 4 });
  d.move({ x: 2, y: 7 });
  check(same(d.pickFrame(), { x: 2, y: 4, w: 3, h: 4 }), 'while picking: the pick rectangle is the frame');
  d.up();
  check(log.join('|') === 'pick 2,4 3x4' && !d.active, 'a pick ends in the picked rectangle');
  log.length = 0;
  d.startPaint({ x: 10, y: 10 });
  for (const [x, y] of [[11, 11], [12, 10], [13, 11], [14, 12], [9, 9]]) d.move({ x, y });
  d.up();
  check(log.join('|') === 'stamp 10,10|stamp 12,10|stamp 14,12|stamp 8,8|end', `a stroke stamps on the 2x2 grid and ends saved (${log.join('|')})`);
  log.length = 0;
  d.startPaint({ x: 0, y: 0 });
  check(d.painting && d.cancel() && log.join('|') === 'stamp 0,0|cancel' && !d.active, 'Esc mid-stroke: cancelled, not saved');
  d.up();
  check(log.join('|') === 'stamp 0,0|cancel', 'the button released after Esc: nothing more');
  check(!d.cancel(), 'Esc with nothing in progress: not taken');
  d.startPick({ x: 1, y: 1 });
  check(d.cancel() && !log.includes('pick 1,1 1x1'), 'Esc mid-pick: nothing picked');
  check(d.pickFrame() === null && same(d.hoverFrame({ x: 30, y: 5 }, { w: 32, h: 32 }), { x: 30, y: 5, w: 2, h: 2 }), 'idle: no pick rectangle, the hover frame is the brush at the mouse');
  check(same(d.hoverFrame({ x: 31, y: 31 }, { w: 32, h: 32 }), { x: 31, y: 31, w: 1, h: 1 }), 'clipped to the picture\'s cells');
}

if (bad) { console.log(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall ok');
