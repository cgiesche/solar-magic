// The Map16 tiles of a level that draw one of some colors (levelColorUsers), for the Animations tab's
// color animations and rotations: against the renderer, with the colors white and every other one
// black, the tiles found are exactly those showing a white pixel (layer 1, and layer 2 or the BG).
import { LevelEmulator } from '../src/core/levelemu.ts';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { renderLevel, levelColorUsers } from '../src/core/render.ts';
import { loadLevel, levelRows } from '../src/core/level.ts';
import { editorImage } from './fixture.ts';

await loadAsar();
const rom = new Rom((await editorImage()).slice());
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const emu = new LevelEmulator(rom);
emu.boot();

const row = (r: number) => Array.from({ length: 15 }, (_, i) => r * 16 + 1 + i);
const cases: [number, number[]][] = [[0x105, [0x21, 0x22, 0x23]], [0x105, [0x41, 0x47]], [0x001, [0x31, 0x32, 0x33, 0x34]], [0x105, [0x83, 0x84]]];
for (const level of [0x105, 0x001, 0x106]) for (let r = 0; r < 8; r++) cases.push([level, row(r)]);
let bgSeen = 0, l2Seen = 0;
for (const [level, colors] of cases) {
  const r = emu.load(level);
  const lv = loadLevel(rom, level);
  const im = renderLevel(rom, r, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
  const set = new Set(colors);
  const users = levelColorUsers(rom, r, im, set);
  // the renderer's answer: the colors white, all others black
  const cgram = new Uint8Array(512);
  for (const c of set) { cgram[c * 2] = 0xff; cgram[c * 2 + 1] = 0x7f; }
  const marked = renderLevel(rom, { ...r, cgram }, lv.header.mode, lv.header.screens, levelRows(lv.secondary));
  const white = marked.layer1.find((p) => p !== 0 && (p & 0xffffff) === 0xffffff) ?? 0xffffffff;
  const shows = (img: Uint32Array, x: number, y: number) => {
    for (let dy = 0; dy < 16; dy++) for (let dx = 0; dx < 16; dx++) if (img[(y * 16 + dy) * marked.width + x * 16 + dx] === white) return true;
    return false;
  };
  const want1 = new Set<number>();
  const g = marked.geom1;
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) if (shows(marked.layer1, x, y)) want1.add(marked.tiles1[y * g.width + x]);
  const got1 = new Set(users.layer1);
  const name = `level ${level.toString(16)}, colors ${colors.map((c) => c.toString(16)).join(' ')}`;
  check(want1.size === got1.size && [...want1].every((t) => got1.has(t)), `${name}: the layer 1 tiles showing them found, no others (${want1.size})`);
  const layer2White = marked.layer2.some((p) => p === white);
  check(layer2White === (users.layer2.length > 0 || users.bg.length > 0), `${name}: layer 2 shows them as found (${layer2White}, layer 2 ${users.layer2.length}, bg ${users.bg.length})`);
  if (users.bg.length) bgSeen++;
  if (layer2White) l2Seen++;
  if (colors[0] >= 0x80) check(!users.layer1.length && !users.layer2.length && !users.bg.length, `${name}: sprite palettes, no Map16 tile`);
}

check(bgSeen > 0 && l2Seen > 0, `some cases reach layer 2 (${l2Seen}) and the BG (${bgSeen})`);

console.log(bad ? `${bad} failures` : 'color users ok');
if (bad) process.exit(1);
