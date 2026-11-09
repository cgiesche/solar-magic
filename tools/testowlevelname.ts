// The selected level tile's name label on the overworld (#422, ui/owlevelname.ts placeLabel): display only, under the
// tile and centred on it, kept inside the map in view – shifted sideways at its edges, above the tile where there is no
// room below, none for a tile out of view.
// node tools/testowlevelname.ts
import { placeLabel } from '../src/ui/owlevelname.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };

const view = { x: 0, y: 0, w: 800, h: 600 }, w = 120, h = 15, gap = 2;
const tile = (x: number, y: number) => ({ x, y, w: 32, h: 32 });
const at = (t: { x: number; y: number; w: number; h: number }, v = view) => placeLabel(t, w, h, v, gap);

let p = at(tile(300, 200));
check(p?.x === 300 + 16 - 60 && p.y === 200 + 32 + gap, `under the tile, centred on it (${JSON.stringify(p)})`);
p = at(tile(10, 200));
check(p?.x === 0 && p.y === 234, `at the left edge: shifted right, inside the view (${JSON.stringify(p)})`);
p = at(tile(780, 200));
check(p?.x === 800 - w && p.y === 234, `at the right edge: shifted left (${JSON.stringify(p)})`);
p = at(tile(300, 560));
check(p?.x === 256 && p.y === 560 - gap - h, `no room below: above the tile (${JSON.stringify(p)})`);
p = at(tile(300, 551));
check(p?.y === 551 + 32 + gap && p.y + h <= 600, `just room below: under it (${JSON.stringify(p)})`);
// the map smaller than the canvas (zoomed out): the view is the part of the canvas the map covers
const small = { x: 0, y: 0, w: 256, h: 256 };
p = at(tile(220, 222), small);
check(p?.x === 256 - w && p.y === 222 - gap - h, `the map's own edges, not the canvas' (${JSON.stringify(p)})`);
// a view lower than tile and label together: in view at its bottom
p = at({ x: 300, y: 0, w: 32, h: 32 }, { x: 0, y: 0, w: 800, h: 40 });
check(p?.y === 40 - h, `room neither below nor above: inside the view at its bottom (${JSON.stringify(p)})`);
check(at(tile(-40, 200)) === null && at(tile(300, 600)) === null && at(tile(300, -32)) === null, 'a tile out of view: no label');
check(at(tile(-20, 200)) !== null, 'a tile partly in view: its label');

console.log(bad ? `\n${bad} FAILED` : '\nall ok');
process.exit(bad ? 1 : 0);
