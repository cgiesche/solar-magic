// Where the level's colors are loaded from (colorsources.ts, the palette tab): traced again only when that may have
// changed. Changing a color (shared or the level's own) keeps the trace; another palette in the level's header, or the
// level's own palette set or removed, traces again; the sources are those of a plain load with source tracking.
import { Rom, pcToSnes, snesToPc } from '../src/core/rom.ts';
import { LevelEmulator, type LevelOverride } from '../src/core/levelemu.ts';
import { loadLevel, type Level } from '../src/core/level.ts';
import { levelOverride } from '../src/core/levelusage.ts';
import { setCustomPalette, customPalette, PALETTE_SIZE } from '../src/core/patches.ts';
import { SHARED_PALETTES, SHARED_PAL_SIZE, tableOf } from '../src/core/sharedpal.ts';
import { ColorSources } from '../src/core/colorsources.ts';
import { editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

const rom = new Rom(await editorImage());
const LEVEL = 0x105;
const lv = loadLevel(rom, LEVEL);
const ov = (l: Level = lv): LevelOverride => levelOverride(rom, l);
const sources = new ColorSources(rom);
// the sources as a plain load with source tracking finds them (on an emulator booted now)
const plain = (o: LevelOverride) => new LevelEmulator(rom).load(LEVEL, { ...o, trackSources: true }).cgramSrc;
// the ROM offsets of the colors loaded from somewhere
const offsets = (src: Int32Array) => { const out: number[] = []; for (let i = 0; i < 256; i++) if (src[i * 2] >= 0 && src[i * 2 + 1] === src[i * 2] + 1) out.push(src[i * 2]); return out; };
const SHARED = snesToPc(SHARED_PALETTES);

const first = sources.trace(LEVEL, ov());
check(sources.traces === 1, 'first trace: a load');
check(same(first.cgramSrc, plain(ov())), 'the sources are those of a plain load with source tracking');
const shared = [...new Set(offsets(first.cgramSrc).filter((o) => o >= SHARED && o < SHARED + SHARED_PAL_SIZE))].map(pcToSnes);
const fg = shared.find((a) => tableOf(SHARED_PALETTES + snesToPc(a) - SHARED).kind === 'fg');
check(fg !== undefined, 'level 105 loads colors of its FG palette');

// a shared color changed: the same trace (a load traced afresh may find another source for some changed colors: the
// tracing matches the values written to those read lately)
rom.w16(fg!, rom.r16(fg!) ^ 0x1f);
check(sources.trace(LEVEL, ov()) === first && sources.traces === 1, 'a shared color changed: not traced again');
for (const a of shared) rom.w16(a, rom.r16(a) ^ 0x3e0);
check(sources.trace(LEVEL, ov()) === first && sources.traces === 1, 'every shared color it loads changed: not traced again');

// another FG palette in the header: traced again, its colors from the other palette
{
  const other = structuredClone(lv);
  other.header.fgPalette = (lv.header.fgPalette + 1) & 7;
  const r = sources.trace(LEVEL, ov(other));
  check(sources.traces === 2, 'another FG palette in the header: traced again');
  check(same(r.cgramSrc, plain(ov(other))), 'its sources are those of a plain load');
  check(!same(r.cgramSrc, first.cgramSrc), 'its sources differ');
  sources.trace(LEVEL, ov());
  check(sources.traces === 3, 'the header as before: traced again');
}

// the level's own palette set: traced again, its colors from the own palette; changing one keeps it; removed: traced again
{
  const base = sources.traces;
  setCustomPalette(rom, LEVEL, new Uint8Array(PALETTE_SIZE).fill(0x21));
  const own = snesToPc(customPalette(rom, LEVEL));
  const r = sources.trace(LEVEL, ov());
  check(sources.traces === base + 1, 'own palette set: traced again');
  check(offsets(r.cgramSrc).some((o) => o >= own && o < own + PALETTE_SIZE), 'its colors come from the own palette');
  check(same(r.cgramSrc, plain(ov())), 'its sources are those of a plain load');
  rom.w16(pcToSnes(own + 0x22), 0x7fff);
  check(sources.trace(LEVEL, ov()) === r && sources.traces === base + 1, 'a color of the own palette changed: not traced again');
  setCustomPalette(rom, LEVEL, null);
  const back = sources.trace(LEVEL, ov());
  check(sources.traces === base + 2, 'own palette removed: traced again');
  check(same(back.cgramSrc, plain(ov())) && !offsets(back.cgramSrc).some((o) => o >= own && o < own + PALETTE_SIZE), 'the sources are the shared ones again');
}

// another level's own palette: not read by this load
{
  const base = sources.traces;
  setCustomPalette(rom, 0x106, new Uint8Array(PALETTE_SIZE).fill(0x42));
  sources.trace(LEVEL, ov());
  check(sources.traces === base, 'another level\'s own palette set: not traced again');
}

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('all ok');
