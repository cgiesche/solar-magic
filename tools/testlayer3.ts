// Layer 3 (layer3.ts): what the layer 3 setting does in a tileset, and how far a rising and falling
// tide moves; the water line found from layer 3 is checked against Mario swimming in it.
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { loadLevel, serializeLayer1, encodeSecondaryHeader, readSecondaryHeader } from '../src/core/level.ts';
import { renderLevel } from '../src/core/render.ts';
import { layer3Kind, layer3Kinds, tideRangeJob, layer3Top, type TideRange } from '../src/core/layer3.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const rom = new Rom(new Uint8Array(readFileSync('test/fixtures/smw.smc')));
const emu = new LevelEmulator(rom); emu.boot();

const ovOf = (n: number, tileset?: number) => {
  const lv = loadLevel(rom, n);
  if (tileset !== undefined) lv.header.tileset = tileset;
  return { layer1: serializeLayer1(rom, lv), secondaryHeader: encodeSecondaryHeader(readSecondaryHeader(rom, n)) };
};

// the vanilla levels as they are
const kinds: [number, string][] = [[0x127, 'tide-moving'], [0x002, 'tide-fixed'], [0x01f, 'image'], [0x009, 'image'], [0x011, 'image'], [0x105, 'none']];
for (const [n, k] of kinds) check(layer3Kind(emu.load(n)) === k, `level ${n.toString(16)}: ${k}`);

// the settings in two tilesets: 1 and 2 are tides, except 2 in the castle tileset
const normal = layer3Kinds(emu, 0x105, ovOf(0x105, 0));
check(normal.join() === 'none,tide-moving,tide-fixed,image', `normal tileset: ${normal.join()}`);
const castle = layer3Kinds(emu, 0x105, ovOf(0x105, 1));
check(castle.join() === 'none,tide-moving,image,image', `castle tileset: ${castle.join()}`);

function run<T>(job: Generator<void, T>): T { for (;;) { const r = job.next(); if (r.done) return r.value; } }
check(run(tideRangeJob(emu, 0x002, {})) === null, 'fixed tide: no range');
const range = run(tideRangeJob(emu, 0x127, {})) as TideRange;
check(!!range && range.min < range.load && range.max > range.load, `level 127: tide moves (${JSON.stringify(range)})`);

// Mario swims below the water line: lowest $96 where he doesn't, with the layer 3 offset d
const lv = loadLevel(rom, 0x127);
const r0 = emu.load(0x127);
const top = layer3Top(renderLevel(rom, r0, lv.header.mode, lv.header.screens).layer3, lv.header.screens * 256);
function swimLine(): number {
  const s = emu.snes, w = s.wram, st = s.saveState();
  const swims = (y: number) => {
    s.loadState(st);
    for (let f = 0; f < 2; f++) { w[0x96] = y & 0xff; w[0x97] = y >> 8; w[0x7d] = 0; w[0x1497] = 0x40; s.runFrame(); }
    return w[0x75] !== 0;
  };
  let lo = 0, hi = 400; // swims at hi, not at lo
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (swims(m)) hi = m; else lo = m; }
  s.loadState(st);
  return hi;
}
const d = (w: Uint8Array) => (((w[0x24] | (w[0x25] << 8)) - (w[0x1c] | (w[0x1d] << 8))) << 16) >> 16;
const s = emu.snes, w = s.wram;
for (let f = 0; f < 60; f++) s.runFrame();
const line0 = swimLine(), d0 = d(w), k = line0 - top;
console.log(`  surface ${top}, swims from $96 = ${line0} (d ${d0})`);
check(top > 0 && Math.abs(k) <= 32, 'swimming starts at the drawn surface');
for (let f = 0; f < 1600 && d(w) - d0 < 40; f++) s.runFrame();
const line1 = swimLine(), d1 = d(w);
console.log(`  after rising: swims from $96 = ${line1} (d ${d1})`);
check(d1 - d0 >= 40 && Math.abs(line1 - (line0 - (d1 - d0))) <= 1, 'the water line moves up by the change of $24 - $1C');

console.log(bad ? `${bad} FAILED` : 'all ok');
process.exit(bad ? 1 : 0);
