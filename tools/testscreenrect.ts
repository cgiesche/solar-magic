// A screen's rectangle in the level picture (screenRect): a horizontal level's screens are side by side, a
// vertical level's stacked, each the full width of the level (32 tiles). Vanilla 105 and 12A.
import { Rom } from '../src/core/rom.ts';
import { loadLevel } from '../src/core/level.ts';
import { layerGeom, screenRect } from '../src/core/render.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(await editorImage());
const rect = (n: number, s: number) => {
  const lv = loadLevel(rom, n), g = layerGeom(rom, 0, lv.header.mode, lv.header.screens);
  return { r: screenRect(g, s), w: g.width * 16, h: g.height * 16 };
};
{
  const { r, w } = rect(0x12a, 1);
  check(r.x === 0 && r.y === 256 && r.w === w && w === 512 && r.h === 256, `12A screen 1: ${JSON.stringify(r)}, level ${w} wide`);
}
{
  const { r, h } = rect(0x105, 2);
  check(r.x === 512 && r.y === 0 && r.w === 256 && r.h === h, `105 screen 2: ${JSON.stringify(r)}, level ${h} high`);
}
process.exit(bad ? 1 : 0);
