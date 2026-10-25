// A whole-ROM .map16 as a graphics part (map16file.ts parseRomMap16, pkgplan.ts): the Romhack Races
// baserom's export/all_map16.map16 (Lunar Magic 3.63). Its FG and BG tiles that differ from the clean game
// are the package's: FG pages 02, 03 keep their numbers, pages 40, 41, 50 (beyond FFF) go to the next
// free pages, BG page 8C keeps its tiles; the GPS blocks of the list sit on the tiles that show them, and
// follow when a page moves. Pages 00–01 of the tilesets and BG pages 80–81 are not taken over: those
// differing from the ROM's are reported. Installed and removed again, the ROM is as before.
import { unzipSync, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { Rom } from '../src/core/rom.ts';
import { loadAsar } from '../src/core/asar.ts';
import { LevelEmulator } from '../src/core/levelemu.ts';
import { map16Source } from '../src/core/render.ts';
import { enableBlocks, extTileWords, actsLike, setExtTileWords } from '../src/core/map16ext.ts';
import { bgExtTileWords } from '../src/core/bgmap16.ts';
import { tilesetPointers, tilesetWords, TILESETS } from '../src/core/tilesets.ts';
import { parseRomMap16, parseMap16File } from '../src/core/map16file.ts';
import { inspectUpload, installPackage, removePackage, planUpload, type UploadPreview, type ReadyPreview, type InstallOptions } from '../src/core/packages.ts';
import { loadBlockProject } from '../src/core/blocks.ts';
import { listPackages } from '../src/core/pkgreg.ts';
import { editorImage, romDiff } from './fixture.ts';

await loadAsar();
let bad = 0;
const check = (ok: boolean, what: string) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) bad++; };
const enc = new TextEncoder();
const hx = (v: number) => v.toString(16).toUpperCase().padStart(3, '0');
const ready = (p: UploadPreview): ReadyPreview => { if (p.status !== 'ready') throw new Error(`${p.name}: ${p.status}${p.status === 'failed' ? ' – ' + p.reason : ''}`); return p; };
const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc.encode(v) : v])));

const baserom = unzipSync(new Uint8Array(readFileSync('test/fixtures/rhr-baserom-5.15.zip')));
const FILE = 'export/all_map16.map16';
const file = baserom[FILE];
// the file read here on its own: FG tile words from 0xB0, acts like from 0x800B0, BG tile words from 0x400B0
const w16 = (o: number) => file[o] | (file[o + 1] << 8);
const fgWords = (t: number) => [0, 1, 2, 3].map((k) => w16(0xb0 + t * 8 + k * 2));
const bgWords = (t: number) => [0, 1, 2, 3].map((k) => w16(0x400b0 + t * 8 + k * 2));
const fileActs = (t: number) => w16(0x800b0 + t * 2);
const page = (t: number) => t >> 8;

// an opened ROM with custom blocks, and the options to install into level 105
async function target(): Promise<{ rom: Rom; opt: InstallOptions; tilesets: number[][][] }> {
  const rom = new Rom(await editorImage());
  const emu = new LevelEmulator(rom); emu.boot();
  const src = map16Source(rom, emu.load(0x105));
  const blank = src.fg(0x025);
  enableBlocks(rom, blank);
  const tilesets = Array.from({ length: TILESETS }, (_, ts) => tilesetWords(rom, tilesetPointers(emu, ts).result));
  return { rom, opt: { level: 0x105, blank, tileWords: (t) => src.fg(t), setup: false }, tilesets };
}

// ---------- the file ----------

{
  const m = parseRomMap16(file);
  check(!!m && m.fg.length === 0x8000 * 4 && m.bg.length === 0x8000 * 4 && m.acts.length === 0x8000 && m.tilesets.length === 15,
    'a whole-ROM .map16: FG and BG tiles 0000–7FFF, acts like, pages 00–01 of 15 tilesets');
  check(!!m && [0x200, 0x2c0, 0x4012, 0x5000].every((t) => Array.from(m.fg.subarray(t * 4, t * 4 + 4)).join() === fgWords(t).join() && m.acts[t] === fileActs(t))
    && Array.from(m.bg.subarray(0xc00 * 4, 0xc00 * 4 + 4)).join() === bgWords(0xc00).join(), 'its tiles as the file has them');
  const partial = baserom['resources/map16/Baserom Global Tiles [Page 02-03].map16'];
  check(parseRomMap16(partial) === null && parseMap16File(partial).tiles.length === 0x200, 'an export of some pages is none');
}

// ---------- the plan ----------

const preview = ready(inspectUpload('rhr-baserom-5.15.zip', zipSync(baserom)));
{
  const { rom, opt, tilesets } = await target();
  const plan = planUpload(rom, preview, opt.blank, tilesets);
  const m = plan.romMap16;
  check(!!m && m.file === FILE && !plan.map16, `the whole-ROM .map16 is the package's Map16 (${m?.file})`);
  const fg = [...(m?.fg ?? [])];
  const pages = [...new Set(fg.map(([f]) => page(f)))];
  check(pages.map((p) => p.toString(16)).join() === '2,3,40,41,50', `FG pages differing from the clean game: ${pages.map((p) => p.toString(16)).join(', ')}`);
  check(fg.every(([f]) => !(fgWords(f).every((v) => v === 0x1004) && fileActs(f) === 0x130)) && fg.every(([f]) => !(fgWords(f).join() === opt.blank.join() && fileActs(f) === 0x25)),
    'the fill of unused tiles and empty tiles are not the package\'s');
  check(fg.filter(([f]) => f < 0x400).every(([f, t]) => f === t), 'pages 02 and 03 keep their numbers');
  const moved = fg.filter(([f]) => f >= 0x1000);
  const shifts = new Map(moved.map(([f, t]) => [page(f), t - f]));
  check(moved.every(([f, t]) => t >= 0x400 && t < 0x1000 && t - f === shifts.get(page(f)) && !((t - f) & 15)) && new Set(moved.map(([, t]) => t)).size === moved.length,
    `pages 40, 41, 50 on free tiles below 1000, their rows kept: ${[...shifts].map(([p, d]) => `${p.toString(16)} → ${hx((p << 8) + d)}`).join(', ')}`);
  const bg = [...(m?.bg ?? [])];
  check(bg.length === 100 && bg.every(([f, t]) => page(f) === 0xc && f === t), `BG page 8C keeps its ${bg.length} tiles`);
  // the blocks on the tiles their list names, those showing them
  const listed = preview.parts.flatMap((b) => (b.kind === 'block' ? b.found.map((x) => [b.file, x.tile!] as const) : []));
  check(listed.length === 140 && listed.every(([f, t]) => plan.blocks.find((b) => b.file === f)?.tiles.includes(t)), `the ${listed.length} block tiles of the list keep their numbers`);
  // tile 2C1 acts like 294, a block's tile: it runs the block's code in Lunar Magic, so it has the block
  const of = (t: number) => plan.blocks.find((b) => b.tiles.includes(t))?.file;
  const acting = fg.filter(([f]) => fileActs(f) >= 0x200 && of(fileActs(f)));
  check(!!of(0x294) && of(0x2c1) === of(0x294) && acting.length === 65 && acting.every(([f, t]) => of(t) === of(fileActs(f))),
    `the ${acting.length} tiles acting like a block's tile have that block (2C1: ${of(0x2c1)})`);
  check(plan.notes.some((n) => /pages 00–01/.test(n) && n.includes('03B') && n.includes('1C4')), 'tiles of the tileset pages that differ are reported: ' + plan.notes.find((n) => /pages 00–01/.test(n)));
  check(plan.notes.some((n) => /BG tiles/.test(n) && n.includes('1ED')), 'BG tiles of pages 80–81 that differ are reported: ' + plan.notes.find((n) => /BG tiles/.test(n)));
  check(plan.notes.filter((n) => n.includes('resources/map16') || /\[Page/.test(n)).length === 7, 'the exports of some pages are not used: ' + plan.notes.find((n) => /\[Page/.test(n)));
}

// a tile of page 02 taken: the page moves, the blocks on it with it
{
  const { rom, opt, tilesets } = await target();
  setExtTileWords(rom, 0x2c1, [1, 2, 3, 4]);
  const plan = planUpload(rom, preview, opt.blank, tilesets);
  const fg = plan.romMap16!.fg;
  const d = fg.get(0x2c0)! - 0x2c0;
  check(d !== 0 && !(d & 15) && [...fg].filter(([f]) => page(f) === 2).every(([f, t]) => t === f + d) && ![...fg.values()].includes(0x2c1), `page 02 moves to ${hx(0x200 + d)} (2C1 is taken)`);
  const onPage2 = plan.blocks.flatMap((b) => b.tiles).filter((t) => t >= 0x200 + d && t < 0x300 + d);
  check(onPage2.length > 0 && onPage2.every((t) => fg.get(t - d) === t || !fg.has(t - d)), `its ${onPage2.length} block tiles move along`);
}

// ---------- installed and removed ----------

{
  const { rom, opt, tilesets } = await target();
  const before = rom.data.slice();
  const block = 'db $42\n' + Array(10).fill('JMP Code').join(' : ') + '\nCode:\n  RTL\n';
  const p = ready(inspectUpload('map16.zip', zip({ 'all_map16.map16': file, 'list.txt': '2C0:130 solid.asm\n', 'solid.asm': block })));
  const plan = planUpload(rom, p, opt.blank, tilesets);
  const r = await installPackage(rom, p, { ...opt, plan });
  if (!r.ok) console.log(r.errors.join('\n'));
  const fg = [...plan.romMap16!.fg];
  check(r.ok && fg.every(([f, t]) => extTileWords(rom, t)!.join() === fgWords(f).join()), `installed: ${fg.length} FG tiles`);
  // acts like followed from tile to tile down to pages 00–01 (2C1 → 294 → 025); the block's tile its own
  const down = (t: number): number => { const a = fileActs(t); return a < 0x200 ? a : down(a); };
  const acts = fg.filter(([f, t]) => actsLike(rom, t) !== (t === 0x2c0 ? 0x130 : down(f)));
  check(!acts.length && actsLike(rom, 0x2c1) === down(0x294), `their acts like, followed to pages 00–01 ${acts.slice(0, 3).map(([f, t]) => `${hx(f)}→${hx(t)}: ${hx(actsLike(rom, t))}`).join(' ')}`);
  check([...plan.romMap16!.bg].every(([f, t]) => bgExtTileWords(rom, t)!.join() === bgWords(f).join()), 'its BG tiles');
  check(loadBlockProject(rom)?.list.some((b) => b.tile === 0x2c0) === true && extTileWords(rom, 0x2c0)!.join() === fgWords(0x2c0).join(), 'the block on tile 2C0, which shows it');
  const pkg = listPackages(rom)[0];
  check(!!pkg && (pkg.map16?.length ?? 0) >= fg.length - 1 && pkg.bgMap16?.length === 100, `the package's Map16 tiles recorded (${pkg?.map16?.length} FG, ${pkg?.bgMap16?.length} BG)`);
  const warnings = await removePackage(rom, r.pkg!.id, opt.blank);
  check(!listPackages(rom).length && romDiff(before, rom.data) === 0, `removed: the Map16 as before (${romDiff(before, rom.data)} bytes differ) ${warnings.join(' ')}`);
}

console.log(bad ? `${bad} failures` : 'all ok');
if (bad) process.exitCode = 1;
