// LC_LZ2 (lz2.ts, #502): what lz2Compress packs unpacks to the input, is no larger than what the compressor packed
// before it was made fast (the sizes below, recorded from it at e616646) and is packed in a few ms. The corpus: every
// LZ2 graphics file of the clean ROM, the editor ROM's packed overworld tables (the translevels and layer 1's high
// bytes, also with level tiles changed) and synthetic inputs (blank, sparse, incrementing, random, tiny, long repeats).
// node tools/testlz2.ts [--sizes: prints the sizes instead of comparing them]
import { Rom, snesToPc } from '../src/core/rom.ts';
import { lz2Compress, lz2Decompress } from '../src/core/lz2.ts';
import { gfxBytes } from '../src/core/gfxfiles.ts';
import { GFX_FILES, gfxEntry } from '../src/core/patches.ts';
import { readL1, readTranslevels } from '../src/core/overworld.ts';
import { cleanImage, editorImage } from './fixture.ts';

let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const hx = (v: number) => v.toString(16).toUpperCase();

// the sizes packed before #502, in the corpus' order
const GFX_SIZES = [
  2013, 2669, 2120, 2508, 2454, 2473, 2402, 2248, 2289, 2636, 2392, 2366, 2026, 1816, 2288, 2005, 2124, 1967, 2272, 2542,
  1634, 1994, 1379, 2191, 2272, 1781, 2116, 1961, 1872, 2490, 1846, 1905, 2167, 2289, 2128, 2178, 2157, 2591, 2227, 2247,
  1503, 1182, 1209, 1711, 2009, 2265, 2006, 448, 1082, 1258,
];
const TABLE_SIZES: Record<string, number> = {
  'translevels': 341,
  'layer 1 high bytes': 7,
  'translevels edited': 451,
  'layer 1 high bytes edited': 168,
};
const SYNTHETIC_SIZES: Record<string, number> = {
  '0 bytes': 1, '1 bytes': 3, '2 bytes': 4, '3 bytes': 5, '4 bytes': 6, '5 bytes': 7,
  '1 equal bytes': 3, '2 equal bytes': 3, '3 equal bytes': 3, '4 equal bytes': 3, '5 equal bytes': 3,
  '0x800 zero bytes': 7,
  '0x1000 zero bytes': 13,
  '0x800 sparse bytes': 278,
  '0x800 random sparse bytes': 517,
  'incrementing 0x800': 7,
  'incrementing words 0x800': 536,
  'random 0x1000': 4225,
  'random of 4 values 0x1000': 2316,
  'random of 2 values 0x2000': 2587,
  'word fill 0x900': 13,
  'a 1500 byte block twice': 1556,
  'a 7 byte period 0x1000': 25,
  'a 300 byte period 0x1800': 335,
  'runs between random bytes': 1655,
  'mostly blank graphics file': 218,
};

// a fixed pseudo random sequence
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}
const make = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i));

const corpus: { group: string; name: string; data: Uint8Array }[] = [];
const clean = new Rom(cleanImage());
const editor = new Rom(await editorImage()); // the graphics files are found by the editor's file table; the game's own keep their bytes
for (let num = 0; num < GFX_FILES; num++) {
  const f = gfxBytes(editor, num);
  if (f && !f.raw) corpus.push({ group: 'gfx', name: `GFX${hx(num).padStart(2, '0')}`, data: f.data });
}
const gfxCount = corpus.length;
const tls = readTranslevels(editor);
corpus.push({ group: 'table', name: 'translevels', data: tls });
corpus.push({ group: 'table', name: 'layer 1 high bytes', data: Uint8Array.from(readL1(editor), (t) => t >> 8) });
{ // as level tile and layer 1 edits leave them
  const r = rng(7), t = tls.slice(), hi = new Uint8Array(0x800);
  for (let k = 0; k < 40; k++) t[(r() << 3) | (r() & 7)] = r() % 0x60;
  for (let k = 0; k < 60; k++) hi[(r() << 3) | (r() & 7)] = 1;
  corpus.push({ group: 'table', name: 'translevels edited', data: t }, { group: 'table', name: 'layer 1 high bytes edited', data: hi });
}
{
  const r = rng(1);
  const syn = (name: string, data: Uint8Array) => corpus.push({ group: 'synthetic', name, data });
  for (let n = 0; n <= 5; n++) syn(`${n} bytes`, make(n, (i) => (i * 37 + 5) & 0xff));
  for (let n = 1; n <= 5; n++) syn(`${n} equal bytes`, make(n, () => 0x42));
  syn('0x800 zero bytes', new Uint8Array(0x800));
  syn('0x1000 zero bytes', new Uint8Array(0x1000));
  syn('0x800 sparse bytes', make(0x800, (i) => (i % 37 === 0 ? (i / 37) & 0xff : 0)));
  syn('0x800 random sparse bytes', make(0x800, () => (r() < 16 ? r() : 0)));
  syn('incrementing 0x800', make(0x800, (i) => i & 0xff));
  syn('incrementing words 0x800', make(0x800, (i) => (i & 1 ? 0x10 : (i >> 1) & 0xff)));
  syn('random 0x1000', make(0x1000, () => r()));
  syn('random of 4 values 0x1000', make(0x1000, () => r() & 3));
  syn('random of 2 values 0x2000', make(0x2000, () => r() & 1));
  syn('word fill 0x900', make(0x900, (i) => (i & 1 ? 0xaa : 0x55)));
  const block = make(1500, () => r());
  syn('a 1500 byte block twice', make(3000, (i) => block[i % 1500])); // a repeat longer than a command's 1024 bytes
  syn('a 7 byte period 0x1000', make(0x1000, (i) => block[i % 7]));
  syn('a 300 byte period 0x1800', make(0x1800, (i) => block[i % 300]));
  syn('runs between random bytes', make(0x1000, (i) => ((i >> 6) & 1 ? block[i % 1500] : (i >> 7) & 0xff)));
  // a mostly blank graphics file: a few drawn tiles in an empty 4bpp file
  syn('mostly blank graphics file', make(0x1000, (i) => (i >> 5) % 23 === 3 ? block[i % 640] & 0x3c : 0));
}

if (process.argv.includes('--sizes')) {
  const of = (g: string) => corpus.filter((c) => c.group === g);
  console.log(`GFX_SIZES = [${of('gfx').map((c) => lz2Compress(c.data).length).join(', ')}]`);
  for (const g of ['table', 'synthetic']) console.log(`${g}: {\n${of(g).map((c) => `  '${c.name}': ${lz2Compress(c.data).length},`).join('\n')}\n}`);
  process.exit(0);
}

check(gfxCount === GFX_SIZES.length, `the clean ROM's LZ2 graphics files (${gfxCount})`);
const before = (c: (typeof corpus)[number], k: number) => (c.group === 'gfx' ? GFX_SIZES[k] : c.group === 'table' ? TABLE_SIZES[c.name] : SYNTHETIC_SIZES[c.name]);
const total: Record<string, { was: number; now: number; ms: number }> = {};
const faults: string[] = [];
for (const [k, c] of corpus.entries()) {
  const t0 = performance.now();
  const packed = lz2Compress(c.data);
  const ms = performance.now() - t0;
  const back = lz2Decompress(packed, 0);
  if (back.size !== packed.length || back.data.length !== c.data.length || back.data.some((b, i) => b !== c.data[i])) faults.push(`${c.name}: does not unpack to the input`);
  if (packed[packed.length - 1] !== 0xff) faults.push(`${c.name}: no end marker`);
  const was = before(c, k);
  if (was === undefined) faults.push(`${c.name}: no size recorded`);
  else if (packed.length > was) faults.push(`${c.name}: ${packed.length} bytes, was ${was}`);
  const t = (total[c.group] ??= { was: 0, now: 0, ms: 0 });
  t.was += was ?? 0; t.now += packed.length; t.ms += ms;
}
for (const f of faults) console.log('     ' + f);
check(!faults.length, `${corpus.length} inputs unpack to themselves, none packed larger than before`);
for (const [g, t] of Object.entries(total)) console.log(`     ${g}: ${t.now} bytes (before ${t.was}), ${t.ms.toFixed(1)} ms`);

// what the game's own streams unpack to is what was packed (the decompressor against the ROM's data, not only against
// the compressor): repacked graphics files are no larger than Nintendo's
{
  let rom = 0, ours = 0;
  for (let num = 0; num < GFX_FILES; num++) {
    const f = gfxBytes(editor, num);
    if (!f || f.raw) continue;
    ours += lz2Compress(f.data).length;
    rom += lz2Decompress(editor.data, snesToPc(gfxEntry(editor, num)!.addr)).size;
  }
  check(ours <= rom, `the graphics files repacked (${ours} bytes) are no larger than in the ROM (${rom})`);
}

// a back reference past what is unpacked so far reads 0, a bad command and an endless stream throw
check(lz2Decompress(Uint8Array.of(0x83, 0x00, 0x00, 0xff), 0).data.join() === '0,0,0,0', 'a back reference past the output reads 0');
check(lz2Decompress(Uint8Array.of(0x00, 7, 0x82, 0x00, 0x00, 0xff), 0).data.join() === '7,7,7,7', 'a back reference overlapping its own output repeats it');
check(lz2Decompress(Uint8Array.of(0xe4 | 1, 0x2b, 9, 0xff), 0).data.length === 0x12c && lz2Decompress(Uint8Array.of(0, 1, 0xff, 0x23, 5, 0xff), 3).size === 3, 'long lengths and an offset');
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
check(throws(() => lz2Decompress(Uint8Array.of(0xa0, 0, 0xff), 0)) && throws(() => lz2Decompress(new Uint8Array(0), 0)), 'a bad command and a stream without end throw');

// the time: single calls of the inputs that were slow (#502: 108, 90, 33 and 16 ms), the best of five; the bounds
// are several times what the compressor needs
const time = (data: Uint8Array) => {
  let best = Infinity;
  for (let k = 0; k < 5; k++) { const t0 = performance.now(); lz2Compress(data); best = Math.min(best, performance.now() - t0); }
  return best;
};
const named = (name: string) => corpus.find((c) => c.name === name)!.data;
const timed: [string, Uint8Array][] = [
  ['0x800 zero bytes', named('0x800 zero bytes')],
  ['a mostly blank 0x1000 graphics file', named('mostly blank graphics file')],
  ['0x1000 bytes of ordinary ROM data', clean.data.slice(0x1000, 0x2000)],
  ['0x800 sparse bytes', named('0x800 sparse bytes')],
];
const BUDGET_MS = 15, CORPUS_BUDGET_MS = 400;
for (const [name, data] of timed) { const ms = time(data); check(ms < BUDGET_MS, `${name}: ${ms.toFixed(2)} ms (under ${BUDGET_MS})`); }
const all = Object.values(total).reduce((s, t) => s + t.ms, 0);
check(all < CORPUS_BUDGET_MS, `the corpus: ${all.toFixed(1)} ms (under ${CORPUS_BUDGET_MS})`);

if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('LZ2 ok');
